"""Launch accounting tests. All mutations are confined to temporary databases."""
import json
import sqlite3
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

import test_match_results as results
from auth_client import SignedClient
from rating_accounting import completed_counts
from repair_rating_counters import repair_counters
from rating_progression import rank_for_elo


class AccountingIntegrationTests(unittest.TestCase):
    setUp = results.MatchResultTests.setUp
    tearDown = results.MatchResultTests.tearDown
    create_match = results.MatchResultTests.create_match
    complete = results.MatchResultTests.complete
    profile = results.MatchResultTests.profile
    record_completed_roster = results.MatchResultTests.record_completed_roster

    def state(self):
        with sqlite3.connect(self.app.config["DATABASE_PATH"]) as connection:
            return {
                table: connection.execute(f"SELECT * FROM {table} ORDER BY id").fetchall()
                for table in ("players", "matches", "elo_history", "priority_events",
                              "elo_adjustments", "progression_repairs")
            }

    def adjust(self, player_id, amount, key="adjustment-intent-1"):
        return self.client.patch(
            f"/api/players/{player_id}",
            json={"elo": self.profile(player_id)["elo"] + amount, "adjustmentRequestId": key},
        )

    def test_approved_repair_backs_up_only_changes_counters_and_is_idempotent(self):
        match = self.complete(self.create_match())
        with sqlite3.connect(self.app.config["DATABASE_PATH"]) as connection:
            connection.execute("UPDATE players SET matches_played=0")
        before = self.state()
        backup, repairs = repair_counters(self.app.config["DATABASE_PATH"], "test-approved-owner")
        self.assertTrue(backup.exists())
        self.assertEqual(len(repairs), 12)
        after = self.state()
        for table in ("matches", "elo_history", "priority_events", "elo_adjustments"):
            self.assertEqual(before[table], after[table])
        with sqlite3.connect(backup) as connection:
            self.assertEqual(connection.execute("SELECT SUM(matches_played) FROM players").fetchone()[0], 0)
        with sqlite3.connect(self.app.config["DATABASE_PATH"]) as connection:
            connection.row_factory = sqlite3.Row
            self.assertEqual(sum(completed_counts(connection).values()), 12)
            self.assertEqual(connection.execute("SELECT SUM(matches_played) FROM players").fetchone()[0], 12)
            self.assertEqual(connection.execute("SELECT SUM(change_amount) FROM elo_history").fetchone()[0],
                             sum(row["changeAmount"] for row in match["eloChanges"]))
        _, repeated = repair_counters(self.app.config["DATABASE_PATH"], "test-approved-owner")
        self.assertEqual(repeated, [])
        self.assertEqual(self.state(), after)

    def test_counter_mismatch_blocks_completion_without_silent_repair(self):
        match = self.create_match()
        with sqlite3.connect(self.app.config["DATABASE_PATH"]) as connection:
            connection.execute("UPDATE players SET matches_played=9")
        before = self.state()
        response = self.client.post(f"/api/matches/{match['id']}/result", json={"scoreA": 3, "scoreB": 1})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.state(), before)

    def test_counts_deduplicate_snapshots_and_ignore_upcoming_reopened_and_audits(self):
        match = self.complete(self.create_match())
        with sqlite3.connect(self.app.config["DATABASE_PATH"]) as connection:
            connection.execute("UPDATE matches SET team_b_json=team_a_json WHERE id=?", (match["id"],))
            connection.row_factory = sqlite3.Row
            counts = completed_counts(connection)
            self.assertEqual(counts, {player_id: 1 for player_id in self.player_ids[:6]})
            connection.execute("UPDATE matches SET status='upcoming' WHERE id=?", (match["id"],))
            self.assertEqual(completed_counts(connection), {})

    def test_duplicate_roster_is_rejected_atomically(self):
        match = self.create_match()
        with sqlite3.connect(self.app.config["DATABASE_PATH"]) as connection:
            connection.execute("UPDATE matches SET team_b_json=team_a_json WHERE id=?", (match["id"],))
        before = self.state()
        response = self.client.post(f"/api/matches/{match['id']}/result", json={"scoreA": 3, "scoreB": 1})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.state(), before)

    def test_positive_and_negative_admin_adjustments_survive_reopen_and_correction(self):
        for amount in (70, -20):
            with self.subTest(amount=amount):
                target = self.player_ids[0]
                original = self.profile(target)
                match = self.complete(self.create_match())
                result = match["eloChanges"][0]
                self.assertEqual(self.adjust(target, amount, f"intent-{amount}").status_code, 200)
                self.assertEqual(self.client.post(f"/api/matches/{match['id']}/reopen").status_code, 200)
                profile = self.profile(target)
                self.assertEqual(profile["elo"], original["elo"] + amount)
                self.assertEqual(profile["rank"], rank_for_elo(original["elo"] + amount))
                self.assertEqual(profile["matchesPlayed"], original["matchesPlayed"])
                reversal = self.client.get(f"/api/players/{target}/elo-history").get_json()[-1]
                self.assertEqual(reversal["changeAmount"], -result["changeAmount"])
                self.assertEqual(reversal["kUsed"], result["kUsed"])
                corrected = self.complete(match)
                self.assertEqual(corrected["eloChanges"][0]["eloBefore"], original["elo"] + amount)
                self.assertEqual(self.client.post(f"/api/matches/{match['id']}/reopen").status_code, 200)
                self.assertEqual(self.profile(target)["elo"], original["elo"] + amount)

    def test_adjustment_survives_completed_match_deletion(self):
        target = self.player_ids[0]
        original = self.profile(target)
        match = self.complete(self.create_match())
        self.assertEqual(self.adjust(target, 70).status_code, 200)
        self.assertEqual(self.client.delete(f"/api/matches/{match['id']}").status_code, 204)
        self.assertEqual(self.profile(target)["elo"], original["elo"] + 70)
        self.assertEqual(self.profile(target)["matchesPlayed"], 0)
        with sqlite3.connect(self.app.config["DATABASE_PATH"]) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM elo_adjustments").fetchone()[0], 1)
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM elo_history WHERE match_id=?", (match["id"],)).fetchone()[0], 0)

    def test_later_dependency_guard_and_multiple_adjustments_preserve_offsets_once(self):
        target = self.player_ids[0]
        original = self.profile(target)
        first = self.complete(self.create_match())
        self.assertEqual(self.adjust(target, 40, "between-matches").status_code, 200)
        second = self.complete(self.create_match())
        self.assertEqual(self.adjust(target, -10, "after-second-match").status_code, 200)
        before = self.state()
        self.assertEqual(self.client.post(f"/api/matches/{first['id']}/reopen").status_code, 409)
        self.assertEqual(self.state(), before)
        self.assertEqual(self.client.post(f"/api/matches/{second['id']}/reopen").status_code, 200)
        self.assertEqual(self.client.post(f"/api/matches/{first['id']}/reopen").status_code, 200)
        self.assertEqual(self.profile(target)["elo"], original["elo"] + 30)
        self.assertEqual(self.profile(target)["matchesPlayed"], 0)

    def test_unaudited_legacy_adjustment_blocks_reversal_without_overwriting(self):
        match = self.complete(self.create_match())
        with sqlite3.connect(self.app.config["DATABASE_PATH"]) as connection:
            connection.execute("UPDATE players SET elo=elo+123 WHERE id=?", (self.player_ids[0],))
        before = self.state()
        response = self.client.post(f"/api/matches/{match['id']}/reopen")
        self.assertEqual(response.status_code, 409)
        self.assertIn("Unrecorded", response.get_json()["error"])
        self.assertEqual(self.state(), before)

    def test_reversal_that_would_be_negative_blocks_without_losing_adjustment(self):
        match = self.complete(self.create_match())
        target = self.player_ids[0]
        self.assertEqual(self.client.patch(f"/api/players/{target}", json={"elo": 0}).status_code, 200)
        before = self.state()
        response = self.client.post(f"/api/matches/{match['id']}/reopen")
        self.assertEqual(response.status_code, 409)
        self.assertIn("negative", response.get_json()["error"])
        self.assertEqual(self.state(), before)
        self.assertEqual(self.profile(target)["elo"], 0)

    def test_adjustment_retry_after_result_is_idempotent_and_conflicting_key_rejected(self):
        target = self.player_ids[0]
        body = {"elo": 1200, "adjustmentRequestId": "stable-retry-intent"}
        self.assertEqual(self.client.patch(f"/api/players/{target}", json=body).status_code, 200)
        self.complete(self.create_match())
        before = self.state()
        self.assertEqual(self.client.patch(f"/api/players/{target}", json=body).status_code, 200)
        self.assertEqual(self.state(), before)
        self.assertEqual(self.client.patch(f"/api/players/{target}", json={**body, "elo": 1300}).status_code, 409)
        self.assertEqual(self.state(), before)

    def test_keyed_noop_remains_noop_after_result_and_key_required_for_real_edit(self):
        target = self.player_ids[0]
        body = {"elo": self.profile(target)["elo"], "adjustmentRequestId": "stable-noop-intent"}
        self.assertEqual(self.client.patch(f"/api/players/{target}", json=body).status_code, 200)
        self.complete(self.create_match())
        before = self.state()
        self.assertEqual(self.client.patch(f"/api/players/{target}", json=body).status_code, 200)
        self.assertEqual(self.state(), before)
        self.assertEqual(self.client.open(f"/api/players/{target}", "PATCH", json={"elo": 999}).status_code, 409)
        self.assertEqual(self.state(), before)

    def test_concurrent_result_submissions_apply_once(self):
        match = self.create_match()
        barrier = threading.Barrier(2)
        def submit():
            client = SignedClient(self.app)
            barrier.wait()
            return client.post(f"/api/matches/{match['id']}/result", json={"scoreA": 3, "scoreB": 1}).status_code
        with ThreadPoolExecutor(max_workers=2) as pool:
            statuses = sorted(pool.map(lambda _: submit(), range(2)))
        self.assertEqual(statuses, [200, 409])
        with sqlite3.connect(self.app.config["DATABASE_PATH"]) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM elo_history").fetchone()[0], 12)
            self.assertEqual(connection.execute("SELECT SUM(matches_played) FROM players").fetchone()[0], 12)

    def test_concurrent_same_adjustment_applies_once(self):
        target = self.player_ids[0]
        barrier = threading.Barrier(2)
        def adjust():
            client = SignedClient(self.app)
            barrier.wait()
            return client.patch(f"/api/players/{target}", json={"elo": 1200, "adjustmentRequestId": "concurrent-adjustment"}).status_code
        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(list(pool.map(lambda _: adjust(), range(2))), [200, 200])
        self.assertEqual(self.profile(target)["elo"], 1200)
        with sqlite3.connect(self.app.config["DATABASE_PATH"]) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM elo_adjustments").fetchone()[0], 1)

    def test_concurrent_different_results_increment_both_without_lost_updates(self):
        matches = [self.create_match(), self.create_match()]
        barrier = threading.Barrier(2)
        def submit(match):
            client = SignedClient(self.app)
            barrier.wait()
            return client.post(f"/api/matches/{match['id']}/result", json={"scoreA": 3, "scoreB": 1}).status_code
        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(list(pool.map(submit, matches)), [200, 200])
        with sqlite3.connect(self.app.config["DATABASE_PATH"]) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM elo_history").fetchone()[0], 24)
            self.assertEqual(connection.execute("SELECT SUM(matches_played) FROM players").fetchone()[0], 24)
        self.assertEqual(self.profile(self.player_ids[0])["matchesPlayed"], 2)

    def test_concurrent_adjustment_and_result_have_a_serializable_reversal(self):
        target = self.player_ids[0]
        match = self.create_match()
        barrier = threading.Barrier(2)
        def submit(kind):
            client = SignedClient(self.app)
            barrier.wait()
            if kind == "result":
                return client.post(f"/api/matches/{match['id']}/result", json={"scoreA": 3, "scoreB": 1}).status_code
            return client.patch(f"/api/players/{target}", json={"elo": 1200, "adjustmentRequestId": "racing-admin-edit"}).status_code
        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(list(pool.map(submit, ("result", "adjustment"))), [200, 200])
        with sqlite3.connect(self.app.config["DATABASE_PATH"]) as connection:
            row = connection.execute(
                "SELECT id,elo_before FROM elo_history WHERE player_id=? AND action='result'", (target,),
            ).fetchone()
            delta = connection.execute(
                "SELECT COALESCE(SUM(change_amount),0) FROM elo_adjustments WHERE player_id=? AND after_history_id>=?",
                (target, row[0]),
            ).fetchone()[0]
        self.assertEqual(self.client.post(f"/api/matches/{match['id']}/reopen").status_code, 200)
        self.assertEqual(self.profile(target)["elo"], row[1] + delta)
        self.assertEqual(self.profile(target)["matchesPlayed"], 0)

    def test_repaired_historical_counter_reversal_preserves_old_k_and_audit_metadata(self):
        for _ in range(29):
            self.record_completed_roster({player_id: "Setter" for player_id in self.player_ids})
        match = self.create_match()
        from app import calculate_elo_updates
        # Simulate the historical zero-based counter bug, not a new result write.
        updates = calculate_elo_updates(
            [{**player, "matchesPlayed": 0} for player in match["teamA"]],
            [{**player, "matchesPlayed": 0} for player in match["teamB"]], "Team A",
        )
        with sqlite3.connect(self.app.config["DATABASE_PATH"]) as connection:
            for change in updates:
                connection.execute("UPDATE players SET elo=?,matches_played=1 WHERE id=?",
                                   (change["eloAfter"], change["playerId"]))
                connection.execute("""
                    INSERT INTO elo_history(
                        player_id,match_id,elo_before,elo_after,change_amount,action,created_at,
                        k_used,rank_before,rank_after,matches_played_before,matches_played_after
                    ) VALUES(?,?,?,?,?,'result','2026-10-08',60,?,?,0,1)
                """, (change["playerId"], match["id"], change["eloBefore"], change["eloAfter"],
                      change["changeAmount"], change["rankBefore"], change["rankAfter"]))
            connection.execute("UPDATE matches SET status='completed',winner='Team A',score_a=3,score_b=1 WHERE id=?", (match["id"],))
        old_audits = self.state()["elo_history"]
        repair_counters(self.app.config["DATABASE_PATH"], "test-approved-owner")
        self.assertEqual(self.profile(self.player_ids[0])["matchesPlayed"], 30)
        self.assertEqual(self.state()["elo_history"], old_audits)
        self.assertEqual(self.client.post(f"/api/matches/{match['id']}/reopen").status_code, 200)
        self.assertEqual(self.profile(self.player_ids[0])["matchesPlayed"], 29)
        reversal = self.client.get(f"/api/players/{self.player_ids[0]}/elo-history").get_json()[-1]
        self.assertEqual((reversal["kUsed"], reversal["matchesPlayedBefore"], reversal["matchesPlayedAfter"]), (60, 30, 29))
        corrected = self.complete(match)
        self.assertTrue(all(change["kUsed"] == 40 for change in corrected["eloChanges"]))
        self.assertEqual(self.state()["elo_history"][:12], old_audits)

    def test_adjustment_insert_failure_rolls_back_player_and_audit(self):
        target = self.player_ids[0]
        with sqlite3.connect(self.app.config["DATABASE_PATH"]) as connection:
            connection.execute("""
                CREATE TRIGGER fail_adjustment BEFORE UPDATE OF elo ON players
                BEGIN SELECT RAISE(ABORT,'injected adjustment failure'); END
            """)
        before = self.state()
        with patch.object(self.app.logger, "error"):
            self.assertEqual(self.adjust(target, 70).status_code, 500)
        self.assertEqual(self.state(), before)

    def test_repair_failure_rolls_back_every_counter_and_audit_row(self):
        self.record_completed_roster({player_id: "Setter" for player_id in self.player_ids})
        with sqlite3.connect(self.app.config["DATABASE_PATH"]) as connection:
            connection.execute("UPDATE players SET matches_played=0")
            connection.execute(f"""
                CREATE TRIGGER fail_counter BEFORE UPDATE OF matches_played ON players
                WHEN NEW.id={self.player_ids[1]}
                BEGIN SELECT RAISE(ABORT,'injected repair failure'); END
            """)
        before = self.state()
        with self.assertRaises(sqlite3.IntegrityError):
            repair_counters(self.app.config["DATABASE_PATH"], "test-approved-owner")
        self.assertEqual(self.state(), before)

    def test_admin_only_audit_and_elo_writes_keep_public_data_private(self):
        target = self.player_ids[0]
        self.assertEqual(self.adjust(target, 70).status_code, 200)
        audit_path = f"/api/admin/players/{target}/rating-audit"
        self.assertEqual(len(self.client.get(audit_path).get_json()["adjustments"]), 1)
        for viewer in (SignedClient(self.app, None, None), SignedClient(self.app, "ordinary-user", "ordinary@example.test")):
            self.assertIn(viewer.get(audit_path).status_code, (401, 403))
            self.assertIn(viewer.patch(f"/api/players/{target}", json={"elo": 5000}).status_code, (401, 403))
            self.assertNotIn("eloBefore", viewer.get("/api/leaderboard").get_data(as_text=True))
        self.assertEqual(self.profile(target)["matchesPlayed"], 0)
        self.assertTrue(self.profile(target)["provisional"])
