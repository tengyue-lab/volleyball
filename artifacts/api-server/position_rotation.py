"""Actual-play history is independent of reversible rating results."""

import json
import sqlite3


def initialize_rotation_schema(connection: sqlite3.Connection) -> None:
    columns = {row[1] for row in connection.execute("PRAGMA table_info(matches)")}
    for name, definition in (
        ("play_disposition", "TEXT CHECK (play_disposition IN ('played', 'voided'))"),
        ("first_played_at", "TEXT"),
    ):
        if name not in columns:
            connection.execute(f"ALTER TABLE matches ADD COLUMN {name} {definition}")
    # No legacy backfill: result reversal did not record whether a game happened.


def position_rotation_history(
    connection: sqlite3.Connection, valid_positions: tuple[str, ...]
) -> list[dict]:
    histories: dict[int, list[int | None]] = {}
    rows = connection.execute("""
        SELECT m.*, (SELECT MIN(h.id) FROM elo_history h
            WHERE h.match_id = m.id AND h.action = 'result') AS first_result_order
        FROM matches m
        WHERE m.play_disposition = 'played' AND m.first_played_at IS NOT NULL
        ORDER BY m.first_played_at DESC, first_result_order DESC, m.id DESC
    """).fetchall()
    for match in rows:
        snapshots = json.loads(match["team_a_json"]) + json.loads(match["team_b_json"])
        audits = {
            row["player_id"]: row
            for row in connection.execute(
                "SELECT * FROM assignment_audit WHERE match_id = ?", (match["id"],)
            )
        }
        # One appearance per player per match, even if corrupt legacy snapshots
        # repeat a player. Missing/unreliable role data still occupies its window.
        by_id: dict[int, list[dict]] = {}
        for snapshot in snapshots:
            by_id.setdefault(snapshot["id"], []).append(snapshot)
        for player_id, entries in by_id.items():
            history = histories.setdefault(player_id, [])
            if len(history) == 3:
                continue
            audit = audits.get(player_id)
            rank = audit["preference_rank"] if audit else None
            reliable = (
                len(entries) == 1 and audit is not None
                and audit["status"] == "preferred"
                and audit["position"] in valid_positions
                and audit["position"] == entries[0].get("assignedPosition")
                and type(rank) is int and 1 <= rank <= 5
            )
            if reliable and isinstance(entries[0].get("positions"), list):
                saved_preferences = entries[0]["positions"]
                reliable = (
                    audit["position"] in saved_preferences
                    and saved_preferences.index(audit["position"]) + 1 == rank
                )
            history.append(rank if reliable else None)
    return [
        {"playerId": player_id, "recentPreferenceRanks": histories[player_id]}
        for player_id in sorted(histories)
    ]
