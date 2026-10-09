"""Every fixture uses an isolated database, not the club roster."""
import json
import sqlite3
import unittest
from unittest.mock import patch

import test_match_results as results
from app import initialize_database
from auth_client import SignedClient


class PositionRotationTests(unittest.TestCase):
    setUp = results.MatchResultTests.setUp
    tearDown = results.MatchResultTests.tearDown
    create_match = results.MatchResultTests.create_match
    complete = results.MatchResultTests.complete
    profile = results.MatchResultTests.profile

    def history(self):
        response = self.client.get("/api/admin/position-rotation-history")
        self.assertEqual(response.status_code, 200)
        return {e["playerId"]: e["recentPreferenceRanks"] for e in response.get_json()}

    def set_opposite_rank(self, player_id, rank):
        positions = ["Setter", "Outside Hitter", "Middle Blocker", "Libero"]
        positions.insert(rank - 1, "Opposite")
        self.assertEqual(self.client.patch(
            f"/api/players/{player_id}", json={"positions": positions}
        ).status_code, 200)

    def test_last_three_appearances_follow_player_across_weeks_and_ignore_upcoming(self):
        target = self.player_ids[5]
        self.assertEqual(self.history(), {})
        for index, rank in enumerate([5, 4, 3, 2]):
            self.set_opposite_rank(target, rank)
            match = self.create_match(matchDate=f"2026-0{index + 1}-01")
            with patch("app.utc_now", return_value=f"2026-0{index + 1}-01T09:00:00.000Z"):
                self.complete(match)
        self.create_match(matchDate="2026-10-10")
        self.assertEqual(self.history()[target], [2, 3, 4])
        self.set_opposite_rank(target, 1)
        self.assertEqual(self.history()[target], [2, 3, 4])
        initialize_database(self.app.config["DATABASE_PATH"])
        self.assertEqual(self.history()[target], [2, 3, 4])

    def test_audit_rank_is_frozen_at_assignment_not_read_from_edited_profile(self):
        target = self.player_ids[5]
        self.set_opposite_rank(target, 5)
        match = self.create_match()
        self.set_opposite_rank(target, 1)
        self.complete(match)
        self.assertEqual(self.history()[target], [5])

    def test_completion_order_not_roster_order_and_correction_does_not_move_appearance(self):
        target = self.player_ids[5]
        self.set_opposite_rank(target, 5)
        first_roster = self.create_match()
        self.set_opposite_rank(target, 3)
        second_roster = self.create_match()
        with patch("app.utc_now", return_value="2026-01-01T00:00:00.000Z"):
            self.complete(second_roster)
            self.complete(first_roster)
        self.assertEqual(self.history()[target], [5, 3])
        self.assertEqual(self.client.post(f"/api/matches/{first_roster['id']}/reopen").status_code, 200)
        self.assertEqual(self.history()[target], [5, 3])
        with patch("app.utc_now", return_value="2026-06-01T00:00:00.000Z"):
            self.complete(first_roster)
        self.assertEqual(self.history()[target], [5, 3])

    def test_reversal_and_recompletion_keep_one_appearance_and_original_order(self):
        first = self.create_match()
        with patch("app.utc_now", return_value="2026-01-01T00:00:00.000Z"):
            played = self.complete(first)
        reopened = self.client.post(f"/api/matches/{first['id']}/reopen").get_json()
        self.assertEqual(reopened["playDisposition"], "played")
        self.assertEqual(reopened["firstPlayedAt"], played["firstPlayedAt"])
        self.assertEqual(self.history()[self.player_ids[0]], [1])
        second = self.create_match()
        with patch("app.utc_now", return_value="2026-02-01T00:00:00.000Z"):
            self.complete(second)
        with patch("app.utc_now", return_value="2026-03-01T00:00:00.000Z"):
            corrected = self.complete(first)
        self.assertEqual(corrected["firstPlayedAt"], played["firstPlayedAt"])
        self.assertEqual(self.history()[self.player_ids[0]], [1, 1])

    def test_unknown_ranks_occupy_appearance_slots_without_pulling_older_ranks(self):
        target = self.player_ids[5]
        matches = []
        for rank in [5, 4, 3, 2]:
            self.set_opposite_rank(target, rank)
            match = self.create_match()
            self.complete(match)
            matches.append(match)
        with sqlite3.connect(self.app.config["DATABASE_PATH"]) as connection:
            connection.execute("UPDATE assignment_audit SET preference_rank=99 WHERE match_id=? AND player_id=?",
                               (matches[-1]["id"], target))
            connection.execute("DELETE FROM assignment_audit WHERE match_id=? AND player_id=?",
                               (matches[-2]["id"], target))
        self.assertEqual(self.history()[target], [None, None, 4])

    def test_void_completed_uses_exact_reversal_preserves_audits_and_excludes_appearance(self):
        before = {pid: self.profile(pid) for pid in self.player_ids}
        match = self.create_match()
        self.complete(match)
        voided = self.client.post(f"/api/matches/{match['id']}/void")
        self.assertEqual(voided.status_code, 200, voided.get_json())
        body = voided.get_json()
        self.assertEqual(body["playDisposition"], "voided")
        self.assertEqual(body["teamA"], match["teamA"])
        self.assertEqual(body["teamB"], match["teamB"])
        for pid in self.player_ids:
            restored = self.profile(pid)
            for key in ("elo", "rank", "matchesPlayed", "preferredRolePriority", "prioritySince"):
                self.assertEqual(restored[key], before[pid][key])
        self.assertEqual(self.history(), {})
        self.assertEqual(self.client.get("/api/matches").get_json(), [])
        self.assertEqual(self.client.post(f"/api/matches/{match['id']}/result",
                                        json={"scoreA": 3, "scoreB": 1}).status_code, 409)
        with sqlite3.connect(self.app.config["DATABASE_PATH"]) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM assignment_audit").fetchone()[0], 12)
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM elo_history WHERE action='reversal'").fetchone()[0], 12)
        self.assertEqual(self.client.post(f"/api/matches/{match['id']}/void").status_code, 200)
        with sqlite3.connect(self.app.config["DATABASE_PATH"]) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM elo_history").fetchone()[0], 24)

    def test_void_unplayed_and_already_reversed_matches_do_not_reverse_twice(self):
        draft = self.create_match()
        self.assertEqual(self.client.post(f"/api/matches/{draft['id']}/void").status_code, 200)
        played = self.create_match()
        self.complete(played)
        self.client.post(f"/api/matches/{played['id']}/reopen")
        before = self.profile(self.player_ids[0])
        self.assertEqual(self.client.post(f"/api/matches/{played['id']}/void").status_code, 200)
        self.assertEqual(self.profile(self.player_ids[0]), before)
        self.assertEqual(self.history(), {})
        with sqlite3.connect(self.app.config["DATABASE_PATH"]) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM elo_history").fetchone()[0], 24)

    def test_history_and_void_are_admin_only(self):
        match = self.create_match()
        for viewer in [SignedClient(self.app, None, None),
                       SignedClient(self.app, "user_rotation_nonadmin", "rotation@example.test")]:
            self.assertIn(viewer.get("/api/admin/position-rotation-history").status_code, (401, 403))
            self.assertIn(viewer.post(f"/api/matches/{match['id']}/void").status_code, (401, 403))
        self.assertEqual(self.client.get(f"/api/matches/{match['id']}").get_json()["playDisposition"], None)

    def test_void_respects_dependent_results_and_transaction_rollback(self):
        first = self.create_match()
        self.complete(first)
        second = self.create_match()
        completed = self.complete(second)
        self.assertEqual(self.client.post(f"/api/matches/{first['id']}/void").status_code, 409)
        before = self.profile(self.player_ids[0])
        with sqlite3.connect(self.app.config["DATABASE_PATH"]) as connection:
            connection.execute("""CREATE TRIGGER reject_void BEFORE UPDATE ON matches
                WHEN NEW.play_disposition='voided'
                BEGIN SELECT RAISE(ABORT, 'test void failure'); END""")
        with self.assertLogs(self.app.logger, level="ERROR"):
            self.assertEqual(self.client.post(f"/api/matches/{second['id']}/void").status_code, 500)
        self.assertEqual(self.profile(self.player_ids[0]), before)
        self.assertEqual(self.client.get(f"/api/matches/{second['id']}").get_json(), completed)
        with sqlite3.connect(self.app.config["DATABASE_PATH"]) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM elo_history WHERE action='reversal'").fetchone()[0], 0)

    def test_migration_is_additive_idempotent_and_does_not_guess_legacy_play_state(self):
        match = self.create_match()
        completed = self.complete(match)
        path = self.app.config["DATABASE_PATH"]
        with sqlite3.connect(path) as connection:
            connection.execute("UPDATE matches SET first_played_at=NULL, play_disposition=NULL")
            snapshot = connection.execute("SELECT team_a_json FROM matches").fetchone()[0]
            audits = connection.execute("SELECT * FROM elo_history").fetchall()
        initialize_database(path)
        initialize_database(path)
        self.assertEqual(self.history(), {})
        with sqlite3.connect(path) as connection:
            self.assertEqual(connection.execute("SELECT team_a_json FROM matches").fetchone()[0], snapshot)
            self.assertEqual(connection.execute("SELECT * FROM elo_history").fetchall(), audits)
            self.assertEqual(connection.execute("SELECT play_disposition, first_played_at FROM matches").fetchone(), (None, None))
        self.assertEqual(self.profile(self.player_ids[0])["elo"], completed["eloChanges"][0]["eloAfter"])
        self.assertEqual(self.client.post(f"/api/matches/{match['id']}/reopen").status_code, 200)
        corrected = self.complete(match)
        self.assertIsNone(corrected["playDisposition"])
        self.assertIsNone(corrected["firstPlayedAt"])
        self.assertEqual(self.history(), {})


if __name__ == "__main__":
    unittest.main()
