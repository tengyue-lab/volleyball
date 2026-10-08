"""Explicit, approved-only repair. Never runs during app startup."""
import argparse
from datetime import datetime, timezone
from pathlib import Path
import sqlite3

from rating_accounting import completed_counts, initialize_accounting


def repair_counters(path, approved_by):
    path = Path(path).resolve()
    if not path.exists():
        raise ValueError("Existing database required.")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    backup = path.parent / "backups" / f"before-counter-repair-{stamp}.sqlite3"
    backup.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path) as connection:
        connection.row_factory = sqlite3.Row
        with sqlite3.connect(backup) as destination:
            connection.backup(destination)
        connection.execute("BEGIN IMMEDIATE")
        initialize_accounting(connection)
        counts = completed_counts(connection)
        changes = []
        for player in connection.execute("SELECT id,matches_played FROM players").fetchall():
            actual = counts.get(player["id"], 0)
            if actual == player["matches_played"]:
                continue
            connection.execute("""
                INSERT INTO progression_repairs(
                    player_id,matches_before,matches_after,approved_by,backup_path,created_at
                ) VALUES(?,?,?,?,?,?)
            """, (player["id"], player["matches_played"], actual, approved_by, str(backup), stamp))
            connection.execute("UPDATE players SET matches_played=? WHERE id=?", (actual, player["id"]))
            changes.append((player["id"], player["matches_played"], actual))
    return backup, changes


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("database")
    parser.add_argument("--approved-by", required=True)
    args = parser.parse_args()
    backup, changes = repair_counters(args.database, args.approved_by)
    print(f"Backup: {backup}")
    print(f"Reconciled {len(changes)} counters; old total {sum(x[1] for x in changes)}, new total {sum(x[2] for x in changes)}.")
