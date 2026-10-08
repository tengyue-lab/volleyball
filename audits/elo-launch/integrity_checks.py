"""Additional synthetic concurrency and compatibility probes; temporary SQLite only."""
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading

from audit_checks import API, ROOT, isolated_app

with tempfile.TemporaryDirectory(prefix="elo-audit-probes-") as temp:
    isolated_app(Path(temp) / "unused-default.sqlite3")
    sys.path.insert(0, str(API / "tests"))
    from test_match_results import MatchResultTests
    from auth_client import SignedClient

    fixture = MatchResultTests("test_match_date_is_saved_separately_and_survives_result_and_reversal")
    fixture.setUp()
    try:
        match = fixture.create_match()
        before = [fixture.client.get(f"/api/players/{pid}").get_json()["elo"] for pid in fixture.player_ids]
        barrier = threading.Barrier(2)

        def submit(_):
            client = SignedClient(fixture.app)
            barrier.wait()
            return client.post(f"/api/matches/{match['id']}/result", json={"scoreA": 25, "scoreB": 20}).status_code

        with ThreadPoolExecutor(max_workers=2) as executor:
            statuses = sorted(executor.map(submit, range(2)))
        assert statuses == [200, 409], statuses
        with sqlite3.connect(fixture.app.config["DATABASE_PATH"]) as connection:
            audit_rows = connection.execute("SELECT COUNT(*) FROM elo_history WHERE action='result'").fetchone()[0]
            counts = [row[0] for row in connection.execute("SELECT matches_played FROM players")]
        assert audit_rows == 12 and counts == [1] * 12
        player_id = fixture.player_ids[0]
        rated = fixture.client.get(f"/api/players/{player_id}").get_json()["elo"]
        manual_edit = fixture.client.patch(f"/api/players/{player_id}", json={"elo": rated + 100})
        assert manual_edit.status_code == 200
        reversal = fixture.client.post(f"/api/matches/{match['id']}/reopen")
        assert reversal.status_code == 200
        restored = [fixture.client.get(f"/api/players/{pid}").get_json()["elo"] for pid in fixture.player_ids]
        assert restored == before
        # This confirms an audit risk, not a proposed change: current exact
        # result reversal overwrites an intervening unaudited admin ELO edit.
        with sqlite3.connect(fixture.app.config["DATABASE_PATH"]) as connection:
            counts_after = [r[0] for r in connection.execute("SELECT matches_played FROM players")]
            assert counts_after == [0] * 12
            invalid_k_blocked = False
            try:
                connection.execute("""
                    INSERT INTO elo_history(player_id,match_id,elo_before,elo_after,change_amount,action,created_at,k_used)
                    VALUES(1,1,800,832,32,'result','synthetic',64)
                """)
            except sqlite3.IntegrityError:
                invalid_k_blocked = True
            assert invalid_k_blocked
        result = {
            "concurrent_result_statuses": statuses,
            "result_audit_rows_after_concurrent_submit": audit_rows,
            "counters_incremented_exactly_once": True,
            "reversal_restored_ratings_and_counters": True,
            "intervening_admin_rating_edit_overwritten_by_reversal": True,
            "candidate_k_64_rejected_by_current_schema": invalid_k_blocked,
        }
        (ROOT / "audits/elo-launch/results/integrity.json").write_text(json.dumps(result, indent=2))
        print(json.dumps(result))
    finally:
        fixture.tearDown()
