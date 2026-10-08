"""Append-only rating administration and authoritative completed appearance counts."""
import hashlib
import json
import sqlite3


class AccountingConflict(ValueError):
    """A write cannot safely preserve the recorded rating history."""


def initialize_accounting(connection: sqlite3.Connection) -> None:
    # Individual statements keep callers' immediate transactions intact.
    connection.execute("""
        CREATE TABLE IF NOT EXISTS elo_adjustments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id INTEGER NOT NULL,
            actor_id TEXT NOT NULL,
            request_key TEXT NOT NULL UNIQUE,
            request_fingerprint TEXT NOT NULL,
            elo_before INTEGER NOT NULL CHECK(elo_before >= 0),
            elo_after INTEGER NOT NULL CHECK(elo_after >= 0),
            change_amount INTEGER NOT NULL,
            after_history_id INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            CHECK(change_amount = elo_after - elo_before)
        )
    """)
    connection.execute("CREATE INDEX IF NOT EXISTS idx_elo_adjustments_player ON elo_adjustments(player_id,id)")
    connection.execute("""
        CREATE TABLE IF NOT EXISTS progression_repairs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id INTEGER NOT NULL,
            matches_before INTEGER NOT NULL CHECK(matches_before >= 0),
            matches_after INTEGER NOT NULL CHECK(matches_after >= 0),
            approved_by TEXT NOT NULL,
            backup_path TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
    """)


def completed_counts(connection: sqlite3.Connection, rows=None) -> dict[int, int]:
    """Each player counts once per currently completed match, never per audit row."""
    counts: dict[int, int] = {}
    if rows is None:
        rows = connection.execute("SELECT team_a_json,team_b_json FROM matches WHERE status='completed'")
    for row in rows:
        ids = {
            player["id"] for snapshot in (row["team_a_json"], row["team_b_json"])
            for player in json.loads(snapshot)
        }
        for player_id in ids:
            counts[player_id] = counts.get(player_id, 0) + 1
    return counts


def require_aligned_counts(players, counts: dict[int, int]) -> None:
    if any(row["matches_played"] != counts.get(row["id"], 0) for row in players):
        raise AccountingConflict(
            "Stored match counters disagree with completed history. "
            "Run the explicitly approved counter repair before changing results."
        )


def record_adjustment(connection, current, changes, body, actor_id, created_at):
    """Called under BEGIN IMMEDIATE. Return True for an exact request retry."""
    key = body.get("adjustmentRequestId")
    if key is not None and (not isinstance(key, str) or not 8 <= len(key) <= 128):
        raise AccountingConflict("Use an adjustment request ID between 8 and 128 characters.")
    fingerprint = hashlib.sha256(json.dumps(
        {"actor": actor_id, "player": current["id"], "body": body},
        sort_keys=True, separators=(",", ":"),
    ).encode()).hexdigest()
    if key is not None:
        previous = connection.execute("SELECT * FROM elo_adjustments WHERE request_key=?", (key,)).fetchone()
        if previous is not None:
            if previous["request_fingerprint"] != fingerprint:
                raise AccountingConflict("This adjustment request ID was already used for different changes.")
            return True
    desired = changes.get("elo", current["elo"])
    # Record keyed no-ops too: a retry after a later result must remain a no-op.
    if desired == current["elo"] and key is None:
        return False
    if key is None:
        raise AccountingConflict("Numeric ELO changes require an adjustmentRequestId so retries cannot apply twice.")
    watermark = connection.execute("SELECT COALESCE(MAX(id),0) FROM elo_history").fetchone()[0]
    connection.execute("""
        INSERT INTO elo_adjustments(
            player_id,actor_id,request_key,request_fingerprint,elo_before,elo_after,
            change_amount,after_history_id,created_at
        ) VALUES(?,?,?,?,?,?,?,?,?)
    """, (current["id"], actor_id, key, fingerprint, current["elo"], desired,
          desired - current["elo"], watermark, created_at))
    return False


def reversal_rating(connection, change, current):
    adjustment = connection.execute("""
        SELECT COALESCE(SUM(change_amount),0) FROM elo_adjustments
        WHERE player_id=? AND after_history_id >= ?
    """, (change["playerId"], change["id"])).fetchone()[0]
    if current is not None and current["elo"] != change["eloAfter"] + adjustment:
        raise AccountingConflict(
            "Unrecorded rating changes prevent a safe reversal. "
            "Review this player's legacy adjustments; no ratings were changed."
        )
    restored = change["eloBefore"] + adjustment
    if restored < 0:
        raise AccountingConflict(
            "Reversal would produce negative ELO after admin adjustments. "
            "Review the adjustment first; no ratings were changed."
        )
    return restored
