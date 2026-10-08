"""Flask API for volleyball player and match management.

The SQLite database is stored alongside this service so the app has no
external database requirement.
"""

from collections import Counter, defaultdict
from contextlib import contextmanager
from datetime import date, datetime, timezone
import json
import math
import os
from pathlib import Path
import sqlite3
from typing import Any, Iterator

from flask import Flask, current_app, g, jsonify, request
from privacy_auth import initialize_auth_schema, install_privacy
from rating_progression import PLACEMENT_MATCHES, STARTING_ELO, is_provisional, k_for_matches, rank_for_elo, rank_movement, tier_elo_ranges, tier_for_elo
from rating_accounting import AccountingConflict, completed_counts, initialize_accounting, require_aligned_counts, record_adjustment, reversal_rating


POSITIONS = (
    "Setter",
    "Outside Hitter",
    "Middle Blocker",
    "Opposite",
    "Libero",
)
SIX_PLAYER_ROLE_COUNTS = Counter(
    {
        "Setter": 1,
        "Outside Hitter": 2,
        "Middle Blocker": 2,
        "Opposite": 1,
        "Libero": 0,
    }
)
SEVEN_PLAYER_ROLE_COUNTS = SIX_PLAYER_ROLE_COUNTS.copy()
SEVEN_PLAYER_ROLE_COUNTS["Libero"] = 1
DEFAULT_DATABASE = Path(__file__).resolve().parent / "data" / "volleyball.sqlite3"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def initialize_database(database_path: str) -> None:
    path = Path(database_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path) as connection:
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode = WAL")
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS players (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                positions_json TEXT NOT NULL,
                elo INTEGER NOT NULL DEFAULT 800 CHECK (elo >= 0),
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS matches (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                team_a_json TEXT NOT NULL,
                team_b_json TEXT NOT NULL,
                score_a INTEGER,
                score_b INTEGER,
                status TEXT NOT NULL DEFAULT 'upcoming'
                    CHECK (status IN ('upcoming', 'completed')),
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS elo_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                player_id INTEGER NOT NULL,
                match_id INTEGER NOT NULL,
                elo_before INTEGER NOT NULL,
                elo_after INTEGER NOT NULL,
                change_amount INTEGER NOT NULL,
                action TEXT NOT NULL DEFAULT 'result'
                    CHECK (action IN ('result', 'reversal')),
                created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_elo_history_player_id
                ON elo_history (player_id, id);
            CREATE INDEX IF NOT EXISTS idx_elo_history_match_id
                ON elo_history (match_id, id);
            """
        )
        match_columns = {
            row[1] for row in connection.execute("PRAGMA table_info(matches)")
        }
        if "winner" not in match_columns:
            connection.execute("ALTER TABLE matches ADD COLUMN winner TEXT")
        if "completed_at" not in match_columns:
            connection.execute("ALTER TABLE matches ADD COLUMN completed_at TEXT")
        if "match_date" not in match_columns:
            connection.execute("ALTER TABLE matches ADD COLUMN match_date TEXT")
        player_columns = {row[1] for row in connection.execute("PRAGMA table_info(players)")}
        if "matches_played" not in player_columns:
            connection.execute(
                "ALTER TABLE players ADD COLUMN matches_played INTEGER NOT NULL DEFAULT 0 "
                "CHECK (matches_played >= 0)"
            )
        history_columns = {row[1] for row in connection.execute("PRAGMA table_info(elo_history)")}
        # Nullable on legacy rows: do not invent placement history or rewrite audits.
        for column, definition in (
            ("k_used", "INTEGER CHECK (k_used IN (20, 32, 40, 60))"),
            ("rank_before", "TEXT"), ("rank_after", "TEXT"),
            ("matches_played_before", "INTEGER CHECK (matches_played_before >= 0)"),
            ("matches_played_after", "INTEGER CHECK (matches_played_after >= 0)"),
        ):
            if column not in history_columns:
                connection.execute(f"ALTER TABLE elo_history ADD COLUMN {column} {definition}")
        if "preferences_confirmed" not in player_columns:
            connection.execute("ALTER TABLE players ADD COLUMN preferences_confirmed INTEGER NOT NULL DEFAULT 0")
        if "priority_since" not in player_columns:
            connection.execute("ALTER TABLE players ADD COLUMN priority_since TEXT")
        connection.executescript("""
            CREATE TABLE IF NOT EXISTS assignment_audit (
                match_id INTEGER NOT NULL, player_id INTEGER NOT NULL,
                position TEXT NOT NULL, status TEXT NOT NULL, preference_rank INTEGER,
                PRIMARY KEY (match_id, player_id)
            );
            CREATE TABLE IF NOT EXISTS priority_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT, match_id INTEGER NOT NULL,
                player_id INTEGER NOT NULL, status TEXT NOT NULL,
                created_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
                completion_order INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_priority_events_player ON priority_events(player_id, id);
        """)
        if "completion_order" not in {row[1] for row in connection.execute("PRAGMA table_info(priority_events)")}:
            connection.execute("ALTER TABLE priority_events ADD COLUMN completion_order INTEGER NOT NULL DEFAULT 0")
            connection.execute("""
                UPDATE priority_events SET completion_order = COALESCE((
                    SELECT MIN(h.id) FROM elo_history h
                    WHERE h.match_id = priority_events.match_id AND h.action = 'result'
                        AND h.created_at = priority_events.created_at
                ), id)
            """)
        # Only recover assignments explicitly present in immutable old snapshots.
        for row in connection.execute("SELECT id, team_a_json, team_b_json FROM matches").fetchall():
            for player in json.loads(row[1]) + json.loads(row[2]):
                if player.get("assignedPosition") in POSITIONS:
                    position = player["assignedPosition"]
                    rank = player["positions"].index(position) + 1 if position in player["positions"] else None
                    connection.execute(
                        "INSERT OR IGNORE INTO assignment_audit VALUES (?, ?, ?, ?, ?)",
                        (row[0], player["id"], position, "preferred" if rank else "filled", rank),
                    )
        # Recover compensation only when both played roles and real completion
        # audit order exist. Never invent positions or completion history.
        completed = connection.execute("""
            SELECT m.id, m.completed_at, MIN(h.id) AS completion_order
            FROM matches m JOIN elo_history h ON h.match_id = m.id
            WHERE m.status = 'completed' AND m.completed_at IS NOT NULL
                AND h.action = 'result'
                AND h.id > COALESCE((SELECT MAX(r.id) FROM elo_history r
                    WHERE r.match_id = m.id AND r.action = 'reversal'), 0)
                AND NOT EXISTS (SELECT 1 FROM priority_events e WHERE e.match_id = m.id)
            GROUP BY m.id ORDER BY completion_order
        """).fetchall()
        for match in completed:
            for assignment in connection.execute("SELECT * FROM assignment_audit WHERE match_id = ?", (match["id"],)).fetchall():
                connection.execute("""
                    INSERT INTO priority_events (match_id,player_id,status,created_at,completion_order)
                    VALUES (?, ?, ?, ?, ?)
                """, (match["id"], assignment["player_id"], assignment["status"], match["completed_at"], match["completion_order"]))
        replay_priority(connection, [row[0] for row in connection.execute("SELECT DISTINCT player_id FROM priority_events")])
        initialize_auth_schema(connection)
        initialize_accounting(connection)


@contextmanager
def database() -> Iterator[sqlite3.Connection]:
    connection = sqlite3.connect(current_app.config["DATABASE_PATH"])
    connection.row_factory = sqlite3.Row
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def assignment_metadata(player: dict[str, Any], position: str) -> dict[str, Any]:
    rank = player["positions"].index(position) + 1 if position in player["positions"] else None
    return {"assignmentStatus": "preferred" if rank else "filled", "preferenceRank": rank}


def replay_priority(connection: sqlite3.Connection, player_ids: list[int]) -> None:
    """Derive state in completion-event order, not roster order or live preferences.

    Replaying only active events makes reversal safe and keeps the earliest
    outstanding Filled completion through repeated Filled assignments.
    """
    for player_id in player_ids:
        pending_since = None
        for event in connection.execute(
            "SELECT status, created_at FROM priority_events WHERE player_id = ? AND active = 1 ORDER BY completion_order, id",
            (player_id,),
        ):
            if event["status"] == "preferred":
                pending_since = None
            elif pending_since is None:
                pending_since = event["created_at"]
        connection.execute("UPDATE players SET priority_since = ? WHERE id = ?", (pending_since, player_id))


def completed_match_history(connection: sqlite3.Connection) -> tuple[Counter[int], dict[int, str]]:
    """Count actual completed appearances and reliable assigned-role history."""
    role_counts: dict[int, Counter[str]] = defaultdict(Counter)
    role_history_reliable: dict[int, bool] = {}
    rows = connection.execute(
        "SELECT team_a_json, team_b_json FROM matches WHERE status = 'completed' ORDER BY id"
    ).fetchall()
    match_counts: Counter[int] = Counter(completed_counts(connection, rows))
    for row in rows:
        match_roles: dict[int, list[Any]] = defaultdict(list)
        for team_json in (row["team_a_json"], row["team_b_json"]):
            for player in json.loads(team_json):
                match_roles[player["id"]].append(player.get("assignedPosition"))
        for player_id, assigned_positions in match_roles.items():
            is_valid_assignment = (
                len(assigned_positions) == 1 and assigned_positions[0] in POSITIONS
            )
            role_history_reliable.setdefault(player_id, True)
            if not is_valid_assignment:
                role_history_reliable[player_id] = False
            else:
                role_counts[player_id][assigned_positions[0]] += 1

    most_played: dict[int, str] = {}
    for player_id, counts in role_counts.items():
        if counts and role_history_reliable.get(player_id, False):
            # POSITIONS order is the deterministic tie-break order.
            most_played[player_id] = max(
                POSITIONS,
                key=lambda position: (counts[position], -POSITIONS.index(position)),
            )
    return match_counts, most_played


def serialize_player(
    row: sqlite3.Row, completed_matches: int | None = None
) -> dict[str, Any]:
    displayed_matches = (
        row["matches_played"] if completed_matches is None else completed_matches
    )
    return {
        "id": row["id"],
        "name": row["name"],
        "positions": json.loads(row["positions_json"]),
        "elo": row["elo"],
        "rank": rank_for_elo(row["elo"]),
        "matchesPlayed": displayed_matches,
        "provisional": is_provisional(displayed_matches),
        "eloPublic": bool(row["elo_public"]),
        "createdAt": row["created_at"],
        "preferencesConfirmed": bool(row["preferences_confirmed"]),
        "preferredRolePriority": row["priority_since"] is not None,
        "prioritySince": row["priority_since"],
    }


def serialize_elo_history_row(row: sqlite3.Row, current_ranks: bool = False) -> dict[str, Any]:
    # Stored historical labels stay intact; match screens use today's tier mapping.
    before = rank_for_elo(row["elo_before"]) if current_ranks and row["rank_before"] is not None else row["rank_before"]
    after = rank_for_elo(row["elo_after"]) if current_ranks and row["rank_after"] is not None else row["rank_after"]
    return {
        "id": row["id"],
        "playerId": row["player_id"],
        "matchId": row["match_id"],
        "eloBefore": row["elo_before"],
        "eloAfter": row["elo_after"],
        "changeAmount": row["change_amount"],
        "kUsed": row["k_used"],
        "rankBefore": before,
        "rankAfter": after,
        "rankMovement": rank_movement(before, after),
        "matchesPlayedBefore": row["matches_played_before"],
        "matchesPlayedAfter": row["matches_played_after"],
        "action": row["action"],
        "createdAt": row["created_at"],
    }


def serialize_match(
    row: sqlite3.Row, elo_changes: list[dict[str, Any]] | None = None,
    draft_editable: bool = False,
) -> dict[str, Any]:
    return {
        "draftEditable": draft_editable,
        "id": row["id"],
        "teamA": json.loads(row["team_a_json"]),
        "teamB": json.loads(row["team_b_json"]),
        "scoreA": row["score_a"],
        "scoreB": row["score_b"],
        "status": row["status"],
        "winner": row["winner"],
        "completedAt": row["completed_at"],
        "createdAt": row["created_at"],
        "eloChanges": elo_changes or [],
        "matchDate": row["match_date"],
    }


def draft_can_edit(connection: sqlite3.Connection, row: sqlite3.Row) -> bool:
    """Check authoritative history inside the mutation's immediate transaction."""
    return (
        row["status"] == "upcoming"
        and row["score_a"] is None and row["score_b"] is None
        and row["completed_at"] is None and row["winner"] is None
        and connection.execute(
            "SELECT 1 FROM elo_history WHERE match_id = ? LIMIT 1", (row["id"],)
        ).fetchone() is None
        and connection.execute(
            "SELECT 1 FROM priority_events WHERE match_id = ? LIMIT 1", (row["id"],)
        ).fetchone() is None
    )


def active_match_elo_changes(
    connection: sqlite3.Connection, match_id: int
) -> list[dict[str, Any]]:
    reversal = connection.execute(
        "SELECT MAX(id) AS last_reversal FROM elo_history "
        "WHERE match_id = ? AND action = 'reversal'",
        (match_id,),
    ).fetchone()
    last_reversal = reversal["last_reversal"] or 0
    rows = connection.execute(
        """
        SELECT * FROM elo_history
        WHERE match_id = ? AND action = 'result' AND id > ?
        ORDER BY id
        """,
        (match_id, last_reversal),
    ).fetchall()
    return [serialize_elo_history_row(row, current_ranks=True) for row in rows]


def reverse_match_result(
    connection: sqlite3.Connection, match_id: int
) -> tuple[sqlite3.Row | None, str | None, int]:
    """Use the same exact reversal for Edit Result and transactional deletion."""
    match = connection.execute(
        "SELECT * FROM matches WHERE id = ?", (match_id,)
    ).fetchone()
    if match is None:
        return None, "Match not found.", 404
    if match["status"] != "completed":
        return None, "Only a completed match can be reopened.", 409

    elo_changes = active_match_elo_changes(connection, match_id)
    if not elo_changes:
        return None, "This completed match has no ELO history to reverse.", 409
    player_ids = [change["playerId"] for change in elo_changes]
    placeholders = ",".join("?" for _ in player_ids)
    last_change_id = max(change["id"] for change in elo_changes)
    later_change = connection.execute(
        f"""
        SELECT h.id FROM elo_history h JOIN matches m ON m.id = h.match_id
        WHERE h.player_id IN ({placeholders})
          AND h.id > ? AND h.match_id != ? AND h.action = 'result'
          AND m.status = 'completed'
          AND h.id > COALESCE((SELECT MAX(r.id) FROM elo_history r
              WHERE r.match_id = h.match_id AND r.action = 'reversal'), 0)
        LIMIT 1
        """,
        (*player_ids, last_change_id, match_id),
    ).fetchone()
    if later_change is not None:
        return None, (
            "A later match has changed one or more of these players' ELO. "
            "Reopen later results first so the rating history stays correct."
        ), 409

    player_rows = connection.execute(
        f"SELECT * FROM players WHERE id IN ({placeholders})", player_ids
    ).fetchall()
    players_by_id = {row["id"]: row for row in player_rows}
    counts, _ = completed_match_history(connection)
    roster_ids = {
        player["id"] for player in json.loads(match["team_a_json"]) + json.loads(match["team_b_json"])
    }
    if set(player_ids) != roster_ids or len(player_ids) != len(set(player_ids)):
        return None, "Result audit and completed roster disagree. Review history before reversal.", 409
    try:
        require_aligned_counts(player_rows, counts)
        restored_ratings = {
            change["playerId"]: reversal_rating(connection, change, players_by_id.get(change["playerId"]))
            for change in elo_changes
        }
    except AccountingConflict as error:
        return None, str(error), 409
    reversed_at = utc_now()
    for change in elo_changes:
        player_id = change["playerId"]
        current_player = players_by_id.get(player_id)
        before_reversal = (
            current_player["elo"] if current_player is not None
            else change["eloAfter"]
        )
        restored_elo = restored_ratings[player_id]
        before_counter = counts.get(player_id, 0)
        recorded_counter = max(0, before_counter - 1)
        if current_player is not None:
            connection.execute(
                "UPDATE players SET elo = ?, matches_played = ? WHERE id = ?",
                 (restored_elo, recorded_counter, player_id),
            )
        connection.execute(
            """
            INSERT INTO elo_history (
                player_id, match_id, elo_before, elo_after,
                change_amount, action, created_at,
                k_used, rank_before, rank_after, matches_played_before, matches_played_after
            ) VALUES (?, ?, ?, ?, ?, 'reversal', ?, ?, ?, ?, ?, ?)
            """,
            (
                player_id, match_id, before_reversal, restored_elo,
                restored_elo - before_reversal, reversed_at, change["kUsed"],
                rank_for_elo(before_reversal),
                rank_for_elo(restored_elo), before_counter, recorded_counter,
            ),
        )
    connection.execute(
        """
        UPDATE matches
        SET score_a = NULL, score_b = NULL, winner = NULL,
            completed_at = NULL, status = 'upcoming'
        WHERE id = ?
        """,
        (match_id,),
    )
    connection.execute("UPDATE priority_events SET active = 0 WHERE match_id = ?", (match_id,))
    replay_priority(connection, player_ids)
    reopened = connection.execute(
        "SELECT * FROM matches WHERE id = ?", (match_id,)
    ).fetchone()
    return reopened, None, 200


def calculate_elo_updates(
    team_a_players: list[dict[str, Any]],
    team_b_players: list[dict[str, Any]],
    winner: str,
) -> list[dict[str, Any]]:
    """Calculate per-player progression changes from pre-match team averages.

    Keep this calculation separate from request handling so the K-factor and
    expected-score formula are straightforward to review and adjust. Ratings
    retain the app's existing minimum of zero.
    """
    average_a = sum(player["elo"] for player in team_a_players) / len(team_a_players)
    average_b = sum(player["elo"] for player in team_b_players) / len(team_b_players)
    exponent = (average_b - average_a) / 400
    if exponent > 308:
        expected_a = 0.0
    elif exponent < -308:
        expected_a = 1.0
    else:
        expected_a = 1 / (1 + math.pow(10, exponent))
    expected_b = 1 - expected_a
    actual_a = 1 if winner == "Team A" else 0
    actual_b = 1 - actual_a

    updates = []
    for players, expected, actual in (
        (team_a_players, expected_a, actual_a),
        (team_b_players, expected_b, actual_b),
    ):
        for player in players:
            old_elo = player["elo"]
            matches_before = player["matchesPlayed"]
            k_used = k_for_matches(matches_before)
            rounded_elo = math.floor(
                old_elo + k_used * (actual - expected) + 0.5
            )
            new_elo = max(0, rounded_elo)
            updates.append(
                {
                    "playerId": player["id"],
                    "eloBefore": old_elo,
                    "eloAfter": new_elo,
                    "changeAmount": new_elo - old_elo,
                    "kUsed": k_used,
                    "rankBefore": rank_for_elo(old_elo),
                    "rankAfter": rank_for_elo(new_elo),
                    "matchesPlayedBefore": matches_before,
                    "matchesPlayedAfter": matches_before + 1,
                }
            )
    return updates


def validate_positions(value: Any) -> tuple[list[str] | None, str | None]:
    if not isinstance(value, list) or not 1 <= len(value) <= 5:
        return None, "Rank between 1 and 5 positions."
    if any(not isinstance(position, str) or position not in POSITIONS for position in value):
        return None, "One or more positions are not supported."
    if len(set(value)) != len(value):
        return None, "Positions must not be repeated."
    return value, None


def validate_match_assignments(
    value: Any, player_ids: list[int]
) -> dict[int, str] | None:
    if not isinstance(value, list) or len(value) != len(player_ids):
        return None

    assignments: dict[int, str] = {}
    for assignment in value:
        if not isinstance(assignment, dict) or not {"playerId", "assignedPosition"} <= set(assignment) or set(assignment) - {"playerId", "assignedPosition", "assignmentStatus", "preferenceRank"}:
            return None
        player_id = assignment["playerId"]
        position = assignment["assignedPosition"]
        if (
            isinstance(player_id, bool)
            or not isinstance(player_id, int)
            or player_id < 1
            or not isinstance(position, str)
            or position not in POSITIONS
            or player_id in assignments
        ):
            return None
        assignments[player_id] = position

    if set(assignments) != set(player_ids):
        return None
    expected = (
        SEVEN_PLAYER_ROLE_COUNTS if len(player_ids) == 7 else SIX_PLAYER_ROLE_COUNTS
    )
    if Counter(assignments.values()) != expected:
        return None
    return assignments


def validate_player_fields(
    body: dict[str, Any], *, partial: bool
) -> tuple[dict[str, Any] | None, str | None]:
    allowed_fields = {"name", "positions", "elo", "eloPublic"}
    if partial:
        allowed_fields.add("adjustmentRequestId")
    if set(body) - allowed_fields:
        return None, "Only name, positions, ELO, and ELO visibility can be changed."
    if partial and not (set(body) & {"name", "positions", "elo", "eloPublic"}):
        return None, "Provide at least one field to update."

    normalized: dict[str, Any] = {}
    if "name" in body:
        name = body["name"]
        if not isinstance(name, str) or not name.strip() or len(name.strip()) > 80:
            return None, "Name must be between 1 and 80 characters."
        normalized["name"] = name.strip()
    elif not partial:
        return None, "Name is required."

    if "positions" in body:
        positions, error = validate_positions(body["positions"])
        if error:
            return None, error
        normalized["positions"] = positions
    elif not partial:
        return None, "Choose at least one position."

    if "elo" in body:
        elo = body["elo"]
        if isinstance(elo, bool) or not isinstance(elo, int) or elo < 0:
            return None, "ELO must be a whole number greater than or equal to 0."
        normalized["elo"] = elo
    elif not partial:
        normalized["elo"] = STARTING_ELO

    if "eloPublic" in body:
        if type(body["eloPublic"]) is not bool:
            return None, "ELO visibility must be true or false."
        normalized["eloPublic"] = body["eloPublic"]
    elif not partial:
        normalized["eloPublic"] = False

    return normalized, None


def create_app(database_path: str | Path | None = None) -> Flask:
    app = Flask(__name__)
    app.config["DATABASE_PATH"] = str(database_path or DEFAULT_DATABASE)
    initialize_database(app.config["DATABASE_PATH"])
    install_privacy(app, database)

    @app.get("/api/healthz")
    def health_check():
        return jsonify({"status": "ok"})

    @app.get("/api/players")
    def list_players():
        with database() as connection:
            rows = connection.execute(
                "SELECT * FROM players ORDER BY name COLLATE NOCASE, id"
            ).fetchall()
            completed_counts, _ = completed_match_history(connection)
        return jsonify([
            serialize_player(row, completed_counts.get(row["id"], 0)) for row in rows
        ])

    @app.post("/api/players")
    def create_player():
        body = request.get_json(silent=True)
        if not isinstance(body, dict):
            return jsonify({"error": "Send player details as a JSON object."}), 400
        player, error = validate_player_fields(body, partial=False)
        if error:
            return jsonify({"error": error}), 400

        created_at = utc_now()
        with database() as connection:
            cursor = connection.execute(
                """
                INSERT INTO players (name, positions_json, elo, created_at, elo_public, preferences_confirmed)
                VALUES (?, ?, ?, ?, ?, 1)
                """,
                (
                    player["name"],
                    json.dumps(player["positions"]),
                    player["elo"],
                    created_at,
                    int(player["eloPublic"]),
                ),
            )
            row = connection.execute(
                "SELECT * FROM players WHERE id = ?", (cursor.lastrowid,)
            ).fetchone()
        return jsonify(serialize_player(row, completed_matches=0)), 201

    @app.get("/api/players/<int:player_id>")
    def get_player(player_id: int):
        with database() as connection:
            row = connection.execute(
                "SELECT * FROM players WHERE id = ?", (player_id,)
            ).fetchone()
            completed_counts, _ = completed_match_history(connection)
        if row is None:
            return jsonify({"error": "Player not found."}), 404
        return jsonify(serialize_player(row, completed_counts.get(player_id, 0)))

    @app.patch("/api/players/<int:player_id>")
    def update_player(player_id: int):
        body = request.get_json(silent=True)
        if not isinstance(body, dict):
            return jsonify({"error": "Send player changes as a JSON object."}), 400
        changes, error = validate_player_fields(body, partial=True)
        if error:
            return jsonify({"error": error}), 400
        if (
            "positions" in changes
            and not g.viewer.get("isAdmin")
            and len(changes["positions"]) < 3
        ):
            return jsonify({"error": "Choose at least three preferred positions."}), 400

        with database() as connection:
            connection.execute("BEGIN IMMEDIATE")
            current = connection.execute(
                "SELECT * FROM players WHERE id = ?", (player_id,)
            ).fetchone()
            if current is None:
                return jsonify({"error": "Player not found."}), 404

            try:
                retried = record_adjustment(connection, current, changes, body, g.viewer["userId"], utc_now())
            except AccountingConflict as error:
                return jsonify({"error": str(error)}), 409
            if retried:
                counts, _ = completed_match_history(connection)
                return jsonify(serialize_player(current, counts.get(player_id, 0)))
            name = changes.get("name", current["name"])
            positions = changes.get(
                "positions", json.loads(current["positions_json"])
            )
            elo = changes.get("elo", current["elo"])
            connection.execute(
                """
                UPDATE players
                SET name = ?, positions_json = ?, elo = ?, preferences_confirmed = ?, elo_public = ?
                WHERE id = ?
                """,
                (name, json.dumps(positions), elo, 1 if "positions" in changes else current["preferences_confirmed"], int(changes.get("eloPublic", bool(current["elo_public"]))), player_id),
            )
            updated = connection.execute(
                "SELECT * FROM players WHERE id = ?", (player_id,)
            ).fetchone()
            completed_counts, _ = completed_match_history(connection)
        return jsonify(serialize_player(updated, completed_counts.get(player_id, 0)))

    @app.patch("/api/profile/preferences")
    def update_own_preferences():
        body = request.get_json(silent=True)
        if not isinstance(body, dict) or set(body) != {"positions"}:
            return jsonify({"error": "Provide only your ranked positions."}), 400
        changes, error = validate_player_fields(body, partial=True)
        if error:
            return jsonify({"error": error}), 400
        positions = changes["positions"]
        if len(positions) < 3:
            return jsonify({"error": "Choose at least three preferred positions."}), 400

        player_id = g.viewer["playerId"]
        with database() as connection:
            current = connection.execute(
                "SELECT * FROM players WHERE id = ?", (player_id,)
            ).fetchone()
            if current is None:
                return jsonify({"error": "Linked player profile not found."}), 404
            connection.execute(
                "UPDATE players SET positions_json = ?, preferences_confirmed = 1 WHERE id = ?",
                (json.dumps(positions), player_id),
            )
            updated = connection.execute(
                "SELECT * FROM players WHERE id = ?", (player_id,)
            ).fetchone()
            completed_counts, _ = completed_match_history(connection)
        return jsonify(serialize_player(updated, completed_counts.get(player_id, 0)))

    @app.delete("/api/players/<int:player_id>")
    def delete_player(player_id: int):
        with database() as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                "INSERT OR REPLACE INTO archived_player_owners (player_id,account_id) "
                "SELECT player_id,id FROM app_accounts WHERE player_id=?", (player_id,)
            )
            connection.execute("UPDATE app_accounts SET player_id=NULL WHERE player_id=?", (player_id,))
            cursor = connection.execute(
                "DELETE FROM players WHERE id = ?", (player_id,)
            )
            if cursor.rowcount == 0:
                return jsonify({"error": "Player not found."}), 404
        return "", 204

    @app.get("/api/rank-tiers")
    def get_rank_tiers():
        return jsonify(tier_elo_ranges())

    @app.get("/api/leaderboard")
    def get_leaderboard():
        with database() as connection:
            completed_counts, most_played_positions = completed_match_history(connection)
            rows = connection.execute(
                "SELECT * FROM players WHERE elo_public=1 ORDER BY elo DESC, name COLLATE NOCASE, id"
            ).fetchall()
        established = [
            row for row in rows
            if completed_counts.get(row["id"], 0) >= PLACEMENT_MATCHES
        ][:5]
        return jsonify([
            {
                "id": row["id"],
                "placement": index,
                "name": row["name"],
                "mostPlayedPosition": most_played_positions.get(row["id"]),
                "tier": tier_for_elo(row["elo"]),
            }
            for index, row in enumerate(established, start=1)
        ])

    @app.get("/api/players/<int:player_id>/elo-history")
    def get_player_elo_history(player_id: int):
        with database() as connection:
            player = connection.execute(
                "SELECT id FROM players WHERE id = ?", (player_id,)
            ).fetchone()
            if player is None:
                return jsonify({"error": "Player not found."}), 404
            rows = connection.execute(
                "SELECT * FROM elo_history WHERE player_id = ? ORDER BY id",
                (player_id,),
            ).fetchall()
        return jsonify([serialize_elo_history_row(row) for row in rows])

    @app.get("/api/admin/players/<int:player_id>/rating-audit")
    def get_admin_rating_audit(player_id: int):
        with database() as connection:
            if connection.execute("SELECT 1 FROM players WHERE id=?", (player_id,)).fetchone() is None:
                return jsonify({"error": "Player not found."}), 404
            adjustments = connection.execute(
                "SELECT id,player_id,actor_id,request_key,elo_before,elo_after,change_amount,after_history_id,created_at "
                "FROM elo_adjustments WHERE player_id=? ORDER BY id", (player_id,),
            ).fetchall()
            repairs = connection.execute(
                "SELECT * FROM progression_repairs WHERE player_id=? ORDER BY id", (player_id,),
            ).fetchall()
        return jsonify({"adjustments": [dict(row) for row in adjustments], "counterRepairs": [dict(row) for row in repairs]})

    @app.get("/api/matches")
    def list_matches():
        with database() as connection:
            rows = connection.execute(
                "SELECT * FROM matches ORDER BY id DESC"
            ).fetchall()
            matches = [serialize_match(row, draft_editable=draft_can_edit(connection, row)) for row in rows]
        return jsonify(matches)

    @app.post("/api/matches")
    @app.patch("/api/matches/<int:match_id>")
    def create_match(match_id: int | None = None):
        body = request.get_json(silent=True)
        if not isinstance(body, dict):
            return jsonify({"error": "Send match rosters as a JSON object."}), 400
        required_fields = {
            "teamAPlayerIds",
            "teamBPlayerIds",
            "teamAAssignments",
            "teamBAssignments",
        }
        if not required_fields <= set(body) or set(body) - required_fields - {"matchDate"}:
            return jsonify(
                {"error": "A match must include both team rosters and role assignments."}
            ), 400
        match_date = body.get("matchDate")
        if "matchDate" in body:
            try:
                if not isinstance(match_date, str) or date.fromisoformat(match_date).isoformat() != match_date:
                    raise ValueError
            except (TypeError, ValueError):
                return jsonify({"error": "Match date must be a valid YYYY-MM-DD date."}), 400

        team_a_ids = body["teamAPlayerIds"]
        team_b_ids = body["teamBPlayerIds"]
        team_a_assignments = body["teamAAssignments"]
        team_b_assignments = body["teamBAssignments"]
        if not isinstance(team_a_ids, list) or not isinstance(team_b_ids, list):
            return jsonify({"error": "Both teams must be lists of player IDs."}), 400
        if any(
            isinstance(player_id, bool) or not isinstance(player_id, int) or player_id < 1
            for player_id in team_a_ids + team_b_ids
        ):
            return jsonify({"error": "Player IDs must be positive whole numbers."}), 400
        if len(set(team_a_ids)) != len(team_a_ids) or len(set(team_b_ids)) != len(
            team_b_ids
        ):
            return jsonify({"error": "A player cannot appear twice on one team."}), 400
        if set(team_a_ids) & set(team_b_ids):
            return jsonify({"error": "A player cannot be on both teams."}), 400
        if len(team_a_ids) not in (6, 7) or len(team_b_ids) not in (6, 7):
            return jsonify(
                {"error": "Each team must have exactly 6 or 7 players."}
            ), 400
        if len(team_a_ids) + len(team_b_ids) not in (12, 13, 14):
            return jsonify(
                {"error": "A match needs 12, 13, or 14 selected players."}
            ), 400
        team_a_roles = validate_match_assignments(team_a_assignments, team_a_ids)
        team_b_roles = validate_match_assignments(team_b_assignments, team_b_ids)
        if team_a_roles is None or team_b_roles is None:
            return jsonify(
                {
                    "error": (
                        "Assign each player exactly one role: six-player teams need "
                        "1 Setter, 2 Outside Hitters, 2 Middle Blockers, and 1 Opposite; "
                        "seven-player teams also need 1 Libero."
                    )
                }
            ), 400

        all_ids = team_a_ids + team_b_ids
        placeholders = ",".join("?" for _ in all_ids)
        with database() as connection:
            connection.execute("BEGIN IMMEDIATE")
            if match_id is not None:
                existing = connection.execute("SELECT * FROM matches WHERE id = ?", (match_id,)).fetchone()
                if existing is None:
                    return jsonify({"error": "Match not found."}), 404
                if not draft_can_edit(connection, existing):
                    return jsonify({"error": "Only unplayed drafts can be edited. This match has result history."}), 409
            rows = connection.execute(
                f"SELECT * FROM players WHERE id IN ({placeholders})", all_ids
            ).fetchall()
            completed_counts, _ = completed_match_history(connection)
            players_by_id = {
                row["id"]: serialize_player(row, completed_counts.get(row["id"], 0))
                for row in rows
            }
            missing_ids = [player_id for player_id in all_ids if player_id not in players_by_id]
            if missing_ids:
                return jsonify(
                    {"error": "One or more selected players no longer exist."}
                ), 400
            if any(not player["preferencesConfirmed"] for player in players_by_id.values()):
                return jsonify({"error": "Confirm ranked preferences for every selected player first."}), 400
            if not any("Setter" in player["positions"] for player in players_by_id.values()):
                return jsonify({"error": "Select at least one Setter-capable player."}), 400
            for assignment in team_a_assignments + team_b_assignments:
                player = players_by_id[assignment["playerId"]]
                position = assignment["assignedPosition"]
                rank = player["positions"].index(position) + 1 if position in player["positions"] else None
                status = "preferred" if rank else "filled"
                if ("assignmentStatus" in assignment and assignment["assignmentStatus"] != status) or ("preferenceRank" in assignment and (isinstance(assignment["preferenceRank"], bool) or assignment["preferenceRank"] != rank)):
                    return jsonify({"error": "Assignment classification and rank must match saved preferences."}), 400

            team_a = [
                {
                    **players_by_id[player_id],
                    "assignedPosition": team_a_roles[player_id],
                    **assignment_metadata(players_by_id[player_id], team_a_roles[player_id]),
                }
                for player_id in team_a_ids
            ]
            team_b = [
                {
                    **players_by_id[player_id],
                    "assignedPosition": team_b_roles[player_id],
                    **assignment_metadata(players_by_id[player_id], team_b_roles[player_id]),
                }
                for player_id in team_b_ids
            ]

            # Assigned positions are stored in the match snapshot, separate
            # from the player's preferred-position profile.
            #
            # ELO changes are applied only when a final score is submitted.
            created_at = utc_now()
            if match_id is None:
                cursor = connection.execute(
                    """
                    INSERT INTO matches (
                        team_a_json, team_b_json, score_a, score_b, status, created_at, match_date
                    ) VALUES (?, ?, NULL, NULL, 'upcoming', ?, ?)
                    """,
                    (json.dumps(team_a), json.dumps(team_b), created_at, match_date),
                )
                match_id = cursor.lastrowid
            else:
                connection.execute(
                    "UPDATE matches SET team_a_json = ?, team_b_json = ?, match_date = ? WHERE id = ?",
                    (json.dumps(team_a), json.dumps(team_b), match_date, match_id),
                )
                # Only never-played draft metadata is synchronized. Result and
                # reversal audits are never rewritten by this operation.
                connection.execute("DELETE FROM assignment_audit WHERE match_id = ?", (match_id,))
            match_row = connection.execute(
                "SELECT * FROM matches WHERE id = ?", (match_id,)
            ).fetchone()
            for player in team_a + team_b:
                connection.execute("INSERT INTO assignment_audit VALUES (?, ?, ?, ?, ?)",
                    (match_id, player["id"], player["assignedPosition"], player["assignmentStatus"], player["preferenceRank"]))

        return jsonify(serialize_match(match_row, draft_editable=True)), 200 if request.method == "PATCH" else 201

    @app.delete("/api/matches/<int:match_id>")
    def delete_match(match_id: int):
        with database() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute("SELECT * FROM matches WHERE id = ?", (match_id,)).fetchone()
            if row is None:
                return jsonify({"error": "Match not found."}), 404
            expected_status = request.args.get("expectedStatus")
            if expected_status not in (None, "upcoming", "completed"):
                return jsonify({"error": "Invalid expected match status."}), 400
            if expected_status is not None and row["status"] != expected_status:
                return jsonify({"error": "The match status changed. Refresh and confirm deletion again."}), 409
            if row["status"] == "completed":
                _, error, status = reverse_match_result(connection, match_id)
                if error:
                    return jsonify({"error": error}), status
            else:
                # Reopened matches retain history, but their applied result is
                # already reversed. Never apply it again or erase active ELO.
                if active_match_elo_changes(connection, match_id):
                    return jsonify({"error": "This upcoming match still has an active ELO result and cannot be deleted safely."}), 409
                if any(row[field] is not None for field in ("score_a", "score_b", "winner", "completed_at")):
                    return jsonify({"error": "This match has inconsistent result state and cannot be deleted safely."}), 409
                if connection.execute(
                    "SELECT 1 FROM priority_events WHERE match_id = ? AND active = 1 LIMIT 1", (match_id,)
                ).fetchone():
                    return jsonify({"error": "This upcoming match still has active priority effects and cannot be deleted safely."}), 409

            # Reversal, dependent-record cleanup and deletion share this
            # transaction: a failure rolls all player changes back as well.
            connection.execute("DELETE FROM elo_history WHERE match_id = ?", (match_id,))
            connection.execute("DELETE FROM priority_events WHERE match_id = ?", (match_id,))
            connection.execute("DELETE FROM assignment_audit WHERE match_id = ?", (match_id,))
            connection.execute("DELETE FROM matches WHERE id = ?", (match_id,))
        return "", 204

    @app.get("/api/matches/<int:match_id>")
    def get_match(match_id: int):
        with database() as connection:
            row = connection.execute(
                "SELECT * FROM matches WHERE id = ?", (match_id,)
            ).fetchone()
            if row is not None and row["status"] == "completed":
                elo_changes = active_match_elo_changes(connection, match_id)
            else:
                elo_changes = []
            editable = row is not None and draft_can_edit(connection, row)
        if row is None:
            return jsonify({"error": "Match not found."}), 404
        return jsonify(serialize_match(row, elo_changes, editable))

    @app.post("/api/matches/<int:match_id>/result")
    def submit_match_result(match_id: int):
        body = request.get_json(silent=True)
        if not isinstance(body, dict) or set(body) != {"scoreA", "scoreB"}:
            return jsonify({"error": "Submit a Team A and Team B score."}), 400
        score_a = body["scoreA"]
        score_b = body["scoreB"]
        if any(
            isinstance(score, bool) or not isinstance(score, int) or score < 0
            for score in (score_a, score_b)
        ):
            return jsonify({"error": "Scores must be whole numbers of zero or higher."}), 400
        if score_a == score_b:
            return jsonify({"error": "A volleyball match cannot end in a tie."}), 400

        winner = "Team A" if score_a > score_b else "Team B"
        with database() as connection:
            connection.execute("BEGIN IMMEDIATE")
            match = connection.execute(
                "SELECT * FROM matches WHERE id = ?", (match_id,)
            ).fetchone()
            if match is None:
                return jsonify({"error": "Match not found."}), 404
            if match["status"] != "upcoming":
                return jsonify(
                    {"error": "This match is already completed. Reopen it before changing the result."}
                ), 409

            team_a_snapshots = json.loads(match["team_a_json"])
            team_b_snapshots = json.loads(match["team_b_json"])
            team_a_ids = [player["id"] for player in team_a_snapshots]
            team_b_ids = [player["id"] for player in team_b_snapshots]
            all_ids = team_a_ids + team_b_ids
            placeholders = ",".join("?" for _ in all_ids)
            rows = connection.execute(
                f"SELECT * FROM players WHERE id IN ({placeholders})", all_ids
            ).fetchall()
            completed_counts, _ = completed_match_history(connection)
            try:
                require_aligned_counts(rows, completed_counts)
            except AccountingConflict as error:
                return jsonify({"error": str(error)}), 409
            if len(set(all_ids)) != len(all_ids):
                return jsonify({"error": "A player appears more than once in this match roster."}), 409
            players_by_id = {
                row["id"]: serialize_player(row, completed_counts.get(row["id"], 0))
                for row in rows
            }
            if any(player_id not in players_by_id for player_id in all_ids):
                return jsonify(
                    {"error": "A roster player no longer exists, so ELO cannot be updated."}
                ), 409

            team_a_players = [players_by_id[player_id] for player_id in team_a_ids]
            team_b_players = [players_by_id[player_id] for player_id in team_b_ids]
            elo_updates = calculate_elo_updates(
                team_a_players, team_b_players, winner
            )
            completed_at = utc_now()
            completion_order = connection.execute("SELECT COALESCE(MAX(id), 0) + 1 FROM elo_history").fetchone()[0]
            for update in elo_updates:
                connection.execute(
                    "UPDATE players SET elo = ?, matches_played = ? WHERE id = ?",
                    (update["eloAfter"], update["matchesPlayedAfter"], update["playerId"]),
                )
                connection.execute(
                    """
                    INSERT INTO elo_history (
                        player_id, match_id, elo_before, elo_after,
                        change_amount, action, created_at,
                        k_used, rank_before, rank_after, matches_played_before, matches_played_after
                    ) VALUES (?, ?, ?, ?, ?, 'result', ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        update["playerId"],
                        match_id,
                        update["eloBefore"],
                        update["eloAfter"],
                        update["changeAmount"],
                        completed_at,
                        update["kUsed"],
                        update["rankBefore"],
                        update["rankAfter"],
                        update["matchesPlayedBefore"],
                        update["matchesPlayedAfter"],
                    ),
                )
            for assignment in connection.execute("SELECT * FROM assignment_audit WHERE match_id = ?", (match_id,)).fetchall():
                connection.execute("INSERT INTO priority_events (match_id, player_id, status, created_at, completion_order) VALUES (?, ?, ?, ?, ?)",
                    (match_id, assignment["player_id"], assignment["status"], completed_at, completion_order))
            replay_priority(connection, all_ids)
            connection.execute(
                """
                UPDATE matches
                SET score_a = ?, score_b = ?, winner = ?,
                    completed_at = ?, status = 'completed'
                WHERE id = ?
                """,
                (score_a, score_b, winner, completed_at, match_id),
            )
            updated_match = connection.execute(
                "SELECT * FROM matches WHERE id = ?", (match_id,)
            ).fetchone()
            elo_changes = active_match_elo_changes(connection, match_id)
        return jsonify(serialize_match(updated_match, elo_changes))

    @app.post("/api/matches/<int:match_id>/reopen")
    def reopen_match_result(match_id: int):
        with database() as connection:
            connection.execute("BEGIN IMMEDIATE")
            reopened_match, error, status = reverse_match_result(connection, match_id)
            if error:
                return jsonify({"error": error}), status
        return jsonify(serialize_match(reopened_match))

    @app.errorhandler(404)
    def json_not_found(_error):
        return jsonify({"error": "Not found."}), 404

    return app


app = create_app()


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))