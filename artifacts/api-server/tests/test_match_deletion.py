import sqlite3
import unittest

import test_match_results as results
from auth_client import SignedClient


class MatchDeletionTests(unittest.TestCase):
    setUp = results.MatchResultTests.setUp
    tearDown = results.MatchResultTests.tearDown
    create_match = results.MatchResultTests.create_match
    complete = results.MatchResultTests.complete
    record_completed_roster = results.MatchResultTests.record_completed_roster

    def snapshot(self):
        with sqlite3.connect(self.app.config["DATABASE_PATH"]) as db:
            return {
                table: db.execute(f"SELECT * FROM {table} ORDER BY 1, 2").fetchall()
                for table in ("players", "matches", "elo_history", "priority_events", "assignment_audit")
            }

    def assert_removed(self, match_id):
        self.assertEqual(self.client.get(f"/api/matches/{match_id}").status_code, 404)
        self.assertNotIn(match_id, [m["id"] for m in self.client.get("/api/matches").get_json()])
        with sqlite3.connect(self.app.config["DATABASE_PATH"]) as db:
            for table in ("elo_history", "priority_events", "assignment_audit"):
                self.assertEqual(db.execute(
                    f"SELECT COUNT(*) FROM {table} WHERE match_id=?", (match_id,)
                ).fetchone()[0], 0)

    def test_completed_deletion_restores_profiles_ranks_provisional_private_and_leaderboard(self):
        for appearance in range(10):
            assignments = {
                player_id: results.ROLE_FORMATION[index % len(results.ROLE_FORMATION)]
                for index, player_id in enumerate(self.player_ids)
                if appearance < (9 if index < 6 else 10)
            }
            self.record_completed_roster(assignments)
        with sqlite3.connect(self.app.config["DATABASE_PATH"]) as db:
            db.execute("UPDATE players SET elo=899, matches_played=9 WHERE id IN (%s)" %
                       ",".join("?" for _ in self.player_ids[:6]), self.player_ids[:6])
            db.execute("UPDATE players SET elo=900, matches_played=10 WHERE id IN (%s)" %
                       ",".join("?" for _ in self.player_ids[6:]), self.player_ids[6:])
            db.execute("UPDATE players SET elo_public=0 WHERE id=?", (self.player_ids[0],))
        before_profiles = self.client.get("/api/players").get_json()
        before_leaderboard = self.client.get("/api/leaderboard").get_json()
        before = self.snapshot()
        match = self.complete(self.create_match())
        changed = self.client.get(f"/api/players/{self.player_ids[0]}").get_json()
        original = next(p for p in before_profiles if p["id"] == self.player_ids[0])
        self.assertNotEqual(changed["rank"], original["rank"])
        self.assertFalse(changed["provisional"])
        self.assertTrue(changed["preferredRolePriority"] is False)
        self.assertEqual(self.client.delete(
            f"/api/matches/{match['id']}?expectedStatus=completed"
        ).status_code, 204)
        self.assertEqual(self.client.get("/api/players").get_json(), before_profiles)
        self.assertEqual(self.client.get("/api/leaderboard").get_json(), before_leaderboard)
        for player in before_profiles:
            self.assertEqual(self.client.get(f"/api/players/{player['id']}").get_json(), player)
            history = self.client.get(f"/api/players/{player['id']}/elo-history").get_json()
            self.assertFalse(any(row["matchId"] == match["id"] for row in history))
        self.assertEqual(self.snapshot(), before)
        self.assert_removed(match["id"])

    def test_delete_restores_earlier_filled_priority_and_preserves_other_match_audits(self):
        first = self.complete(self.create_match())
        player_id = self.player_ids[5]
        prior = self.client.get(f"/api/players/{player_id}").get_json()
        self.assertTrue(prior["preferredRolePriority"])
        self.client.patch(f"/api/players/{player_id}", json={
            "positions": ["Opposite", "Setter", "Outside Hitter"]
        })
        before = self.snapshot()
        second = self.complete(self.create_match())
        self.assertFalse(self.client.get(f"/api/players/{player_id}").get_json()["preferredRolePriority"])
        self.assertEqual(self.client.delete(f"/api/matches/{second['id']}").status_code, 204)
        restored = self.client.get(f"/api/players/{player_id}").get_json()
        self.assertTrue(restored["preferredRolePriority"])
        self.assertEqual(restored["prioritySince"], prior["prioritySince"])
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.client.get(f"/api/matches/{first['id']}").status_code, 200)
        self.assert_removed(second["id"])

    def test_already_reopened_match_deletes_without_reversing_again_or_touching_later_result(self):
        first = self.complete(self.create_match())
        self.assertEqual(self.client.post(f"/api/matches/{first['id']}/reopen").status_code, 200)
        second = self.complete(self.create_match())
        before = self.snapshot()
        self.assertEqual(self.client.delete(f"/api/matches/{first['id']}").status_code, 204)
        after = self.snapshot()
        self.assertEqual(after["players"], before["players"])
        for table in ("elo_history", "priority_events", "assignment_audit"):
            index = 0 if table == "assignment_audit" else 2 if table == "elo_history" else 1
            self.assertEqual(after[table], [row for row in before[table] if row[index] != first["id"]])
        self.assertEqual(self.client.get(f"/api/matches/{second['id']}").status_code, 200)
        self.assert_removed(first["id"])

    def test_later_dependent_result_blocks_delete_without_mutation_then_reverse_order_succeeds(self):
        original = self.client.get("/api/players").get_json()
        first = self.complete(self.create_match())
        second = self.complete(self.create_match())
        before = self.snapshot()
        rejected = self.client.delete(f"/api/matches/{first['id']}")
        self.assertEqual(rejected.status_code, 409)
        self.assertIn("later match", rejected.get_json()["error"])
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.client.delete(f"/api/matches/{second['id']}").status_code, 204)
        self.assertEqual(self.client.delete(f"/api/matches/{first['id']}").status_code, 204)
        self.assertEqual(self.client.get("/api/players").get_json(), original)
        self.assert_removed(first["id"])
        self.assert_removed(second["id"])

    def test_missing_or_active_inconsistent_result_history_fails_closed(self):
        match = self.create_match()
        with sqlite3.connect(self.app.config["DATABASE_PATH"]) as db:
            db.execute("UPDATE matches SET status='completed' WHERE id=?", (match["id"],))
        before = self.snapshot()
        self.assertEqual(self.client.delete(f"/api/matches/{match['id']}").status_code, 409)
        self.assertEqual(self.snapshot(), before)
        with sqlite3.connect(self.app.config["DATABASE_PATH"]) as db:
            db.execute("UPDATE matches SET status='upcoming' WHERE id=?", (match["id"],))
        self.complete(match)
        with sqlite3.connect(self.app.config["DATABASE_PATH"]) as db:
            db.execute("UPDATE matches SET status='upcoming',score_a=NULL,score_b=NULL,winner=NULL,completed_at=NULL WHERE id=?", (match["id"],))
        before = self.snapshot()
        self.assertEqual(self.client.delete(f"/api/matches/{match['id']}").status_code, 409)
        self.assertEqual(self.snapshot(), before)

    def test_reversal_or_delete_failure_rolls_back_all_match_and_player_changes(self):
        match = self.complete(self.create_match())
        for statement in (
            "CREATE TRIGGER reject_operation BEFORE INSERT ON elo_history WHEN NEW.action='reversal' BEGIN SELECT RAISE(ABORT,'test reversal failure'); END",
            "CREATE TRIGGER reject_operation BEFORE DELETE ON matches BEGIN SELECT RAISE(ABORT,'test delete failure'); END",
        ):
            before = self.snapshot()
            with sqlite3.connect(self.app.config["DATABASE_PATH"]) as db:
                db.execute(statement)
            response = self.client.delete(f"/api/matches/{match['id']}")
            self.assertEqual(response.status_code, 500)
            self.assertEqual(self.snapshot(), before)
            with sqlite3.connect(self.app.config["DATABASE_PATH"]) as db:
                db.execute("DROP TRIGGER reject_operation")

    def test_only_admin_can_delete_draft_or_completed_and_status_must_match_confirmation(self):
        normal = SignedClient(self.app, user_id="user_delete_normal", email="delete-normal@example.test")
        for completed in (False, True):
            match = self.create_match()
            if completed:
                match = self.complete(match)
            before = self.snapshot()
            for client in (normal, self.app.test_client()):
                self.assertEqual(client.delete(f"/api/matches/{match['id']}").status_code, 403)
            incorrect = "upcoming" if completed else "completed"
            self.assertEqual(self.client.delete(
                f"/api/matches/{match['id']}?expectedStatus={incorrect}"
            ).status_code, 409)
            self.assertEqual(self.snapshot(), before)
            self.assertEqual(self.client.delete(
                f"/api/matches/{match['id']}?expectedStatus={match['status']}"
            ).status_code, 204)
            self.assert_removed(match["id"])
