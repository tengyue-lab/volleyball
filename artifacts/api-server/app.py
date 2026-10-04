"""Flask API for volleyball player and match management.

The SQLite database is stored alongside this service so the app has no
external database requirement.
"""

from contextlib import contextmanager
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sqlite3
from typing import Any, Iterator

from flask import Flask, current_app, jsonify, request


POSITIONS = (
    "Setter",
    "Outside Hitter",
    "Middle Blocker",
    "Opposite",
    "Libero",
)
DEFAULT_DATABASE = Path(__file__).resolve().parent / "data" / "volleyball.sqlite3"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def initialize_database(database_path: str) -> None:
    path = Path(database_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path) as connection:
        connection.execute("PRAGMA journal_mode = WAL")
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS players (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                positions_json TEXT NOT NULL,
                elo INTEGER NOT NULL DEFAULT 1000 CHECK (elo >= 0),
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
            """
        )


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


def serialize_player(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "positions": json.loads(row["positions_json"]),
        "elo": row["elo"],
        "createdAt": row["created_at"],
    }


def serialize_match(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "teamA": json.loads(row["team_a_json"]),
        "teamB": json.loads(row["team_b_json"]),
        "scoreA": row["score_a"],
        "scoreB": row["score_b"],
        "status": row["status"],
        "createdAt": row["created_at"],
    }


def validate_positions(value: Any) -> tuple[list[str] | None, str | None]:
    if not isinstance(value, list) or not value:
        return None, "Choose at least one position."
    if any(not isinstance(position, str) or position not in POSITIONS for position in value):
        return None, "One or more positions are not supported."
    if len(set(value)) != len(value):
        return None, "Positions must not be repeated."
    return value, None


def validate_player_fields(
    body: dict[str, Any], *, partial: bool
) -> tuple[dict[str, Any] | None, str | None]:
    allowed_fields = {"name", "positions", "elo"}
    if set(body) - allowed_fields:
        return None, "Only name, positions, and ELO can be changed."
    if partial and not body:
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
        normalized["elo"] = 1000

    return normalized, None


def create_app(database_path: str | Path | None = None) -> Flask:
    app = Flask(__name__)
    app.config["DATABASE_PATH"] = str(database_path or DEFAULT_DATABASE)
    initialize_database(app.config["DATABASE_PATH"])

    @app.get("/api/healthz")
    def health_check():
        return jsonify({"status": "ok"})

    @app.get("/api/players")
    def list_players():
        with database() as connection:
            rows = connection.execute(
                "SELECT * FROM players ORDER BY name COLLATE NOCASE, id"
            ).fetchall()
        return jsonify([serialize_player(row) for row in rows])

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
                INSERT INTO players (name, positions_json, elo, created_at)
                VALUES (?, ?, ?, ?)
                """,
                (
                    player["name"],
                    json.dumps(player["positions"]),
                    player["elo"],
                    created_at,
                ),
            )
            row = connection.execute(
                "SELECT * FROM players WHERE id = ?", (cursor.lastrowid,)
            ).fetchone()
        return jsonify(serialize_player(row)), 201

    @app.get("/api/players/<int:player_id>")
    def get_player(player_id: int):
        with database() as connection:
            row = connection.execute(
                "SELECT * FROM players WHERE id = ?", (player_id,)
            ).fetchone()
        if row is None:
            return jsonify({"error": "Player not found."}), 404
        return jsonify(serialize_player(row))

    @app.patch("/api/players/<int:player_id>")
    def update_player(player_id: int):
        body = request.get_json(silent=True)
        if not isinstance(body, dict):
            return jsonify({"error": "Send player changes as a JSON object."}), 400
        changes, error = validate_player_fields(body, partial=True)
        if error:
            return jsonify({"error": error}), 400

        with database() as connection:
            current = connection.execute(
                "SELECT * FROM players WHERE id = ?", (player_id,)
            ).fetchone()
            if current is None:
                return jsonify({"error": "Player not found."}), 404

            name = changes.get("name", current["name"])
            positions = changes.get(
                "positions", json.loads(current["positions_json"])
            )
            elo = changes.get("elo", current["elo"])
            connection.execute(
                """
                UPDATE players
                SET name = ?, positions_json = ?, elo = ?
                WHERE id = ?
                """,
                (name, json.dumps(positions), elo, player_id),
            )
            updated = connection.execute(
                "SELECT * FROM players WHERE id = ?", (player_id,)
            ).fetchone()
        return jsonify(serialize_player(updated))

    @app.delete("/api/players/<int:player_id>")
    def delete_player(player_id: int):
        with database() as connection:
            cursor = connection.execute(
                "DELETE FROM players WHERE id = ?", (player_id,)
            )
            if cursor.rowcount == 0:
                return jsonify({"error": "Player not found."}), 404
        return "", 204

    @app.get("/api/leaderboard")
    def get_leaderboard():
        with database() as connection:
            rows = connection.execute(
                "SELECT * FROM players ORDER BY elo DESC, name COLLATE NOCASE, id"
            ).fetchall()
        return jsonify([serialize_player(row) for row in rows])

    @app.get("/api/matches")
    def list_matches():
        with database() as connection:
            rows = connection.execute(
                "SELECT * FROM matches ORDER BY id DESC"
            ).fetchall()
        return jsonify([serialize_match(row) for row in rows])

    @app.post("/api/matches")
    def create_match():
        body = request.get_json(silent=True)
        if not isinstance(body, dict):
            return jsonify({"error": "Send match rosters as a JSON object."}), 400
        if set(body) != {"teamAPlayerIds", "teamBPlayerIds"}:
            return jsonify(
                {"error": "A match must include Team A and Team B player IDs."}
            ), 400

        team_a_ids = body["teamAPlayerIds"]
        team_b_ids = body["teamBPlayerIds"]
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

        all_ids = team_a_ids + team_b_ids
        placeholders = ",".join("?" for _ in all_ids)
        with database() as connection:
            rows = connection.execute(
                f"SELECT * FROM players WHERE id IN ({placeholders})", all_ids
            ).fetchall()
            players_by_id = {row["id"]: serialize_player(row) for row in rows}
            missing_ids = [player_id for player_id in all_ids if player_id not in players_by_id]
            if missing_ids:
                return jsonify(
                    {"error": "One or more selected players no longer exist."}
                ), 400

            team_a = [players_by_id[player_id] for player_id in team_a_ids]
            team_b = [players_by_id[player_id] for player_id in team_b_ids]

            # Match creation enforces the Libero rules for 13-player and
            # 14-player pools; position coverage and ELO balancing happen in
            # the match builder before this roster is submitted.
            #
            # Phase 4 ELO updates should use both pre-match team averages:
            # expected_A = 1 / (1 + 10 ** ((average_B - average_A) / 400)).
            # For a win/loss, actual_A is 1 or 0; each Team A player's change
            # is round(32 * (actual_A - expected_A)). Team B uses the inverse
            # expectation and result. This makes upsets worth more and keeps
            # roster creation from changing ratings before a result is entered.
            if len(all_ids) == 13:
                larger_team, smaller_team = (
                    (team_a, team_b) if len(team_a) == 7 else (team_b, team_a)
                )
                larger_has_libero = any(
                    "Libero" in player["positions"] for player in larger_team
                )
                smaller_has_libero = any(
                    "Libero" in player["positions"] for player in smaller_team
                )
                if not larger_has_libero or smaller_has_libero:
                    return jsonify(
                        {
                            "error": "For 13 players, assign a Libero-capable player to the 7-player team and none to the 6-player team."
                        }
                    ), 400
            elif len(all_ids) == 14:
                if not all(
                    any("Libero" in player["positions"] for player in team)
                    for team in (team_a, team_b)
                ):
                    return jsonify(
                        {
                            "error": "For 14 players, each 7-player team must include a Libero-capable player."
                        }
                    ), 400

            created_at = utc_now()
            cursor = connection.execute(
                """
                INSERT INTO matches (
                    team_a_json, team_b_json, score_a, score_b, status, created_at
                ) VALUES (?, ?, NULL, NULL, 'upcoming', ?)
                """,
                (json.dumps(team_a), json.dumps(team_b), created_at),
            )
            match_row = connection.execute(
                "SELECT * FROM matches WHERE id = ?", (cursor.lastrowid,)
            ).fetchone()

        return jsonify(serialize_match(match_row)), 201

    @app.get("/api/matches/<int:match_id>")
    def get_match(match_id: int):
        with database() as connection:
            row = connection.execute(
                "SELECT * FROM matches WHERE id = ?", (match_id,)
            ).fetchone()
        if row is None:
            return jsonify({"error": "Match not found."}), 404
        return jsonify(serialize_match(row))

    @app.errorhandler(404)
    def json_not_found(_error):
        return jsonify({"error": "Not found."}), 404

    return app


app = create_app()


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))