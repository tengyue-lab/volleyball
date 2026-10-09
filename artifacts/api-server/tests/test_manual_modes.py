"""Role-free fixtures use temporary databases only."""
import json
import sqlite3
import unittest
from unittest.mock import patch

import test_match_results as results
import test_position_rotation as rotation
from app import initialize_database
from auth_client import SignedClient


class ManualModeTests(unittest.TestCase):
    setUp = results.MatchResultTests.setUp
    tearDown = results.MatchResultTests.tearDown
    create_match = results.MatchResultTests.create_match
    complete = results.MatchResultTests.complete
    profile = results.MatchResultTests.profile
    history = rotation.PositionRotationTests.history
    set_opposite_rank = rotation.PositionRotationTests.set_opposite_rank

    def body(self, ids=None):
        ids = ids or self.player_ids
        return {"manualMode": "no_roles_lock", "matchDate": "2026-10-10",
                "teamAPlayerIds": ids[:6], "teamBPlayerIds": ids[6:],
                "teamAAssignments": [], "teamBAssignments": []}

    def role_free(self, ids=None):
        response = self.client.post("/api/matches", json=self.body(ids))
        self.assertEqual(response.status_code, 201, response.get_json())
        return response.get_json()

    def rows(self, table, match_id):
        with sqlite3.connect(self.app.config["DATABASE_PATH"]) as db:
            return db.execute(f"SELECT * FROM {table} WHERE match_id = ?", (match_id,)).fetchall()

    def test_supported_sizes_save_reload_and_edit_without_roles_or_setter(self):
        for count in (12, 13, 14):
            with self.subTest(count=count):
                ids = list(self.player_ids)
                for i in range(count - 12):
                    response = self.client.post("/api/players", json={"name": f"Extra {count}-{i}", "positions": ["Opposite"]})
                    self.assertEqual(response.status_code, 201)
                    ids.append(response.get_json()["id"])
                with sqlite3.connect(self.app.config["DATABASE_PATH"]) as db:
                    db.execute("UPDATE players SET positions_json = ?, preferences_confirmed = 0", (json.dumps(["Opposite"]),))
                body = self.body(ids)
                if count == 14:
                    body["teamAPlayerIds"], body["teamBPlayerIds"] = ids[:7], ids[7:]
                response = self.client.post("/api/matches", json=body)
                self.assertEqual(response.status_code, 201, response.get_json())
                match = response.get_json()
                loaded = self.client.get(f"/api/matches/{match['id']}").get_json()
                self.assertEqual(loaded["manualMode"], "no_roles_lock")
                self.assertTrue(loaded["draftEditable"])
                for p in loaded["teamA"] + loaded["teamB"]:
                    for key in ("assignedPosition", "assignmentStatus", "preferenceRank"):
                        self.assertIsNone(p[key])
                self.assertEqual(self.rows("assignment_audit", match["id"]), [])
                self.assertEqual(self.rows("elo_history", match["id"]), [])
                a, b = body["teamAPlayerIds"], body["teamBPlayerIds"]
                a[0], b[0] = b[0], a[0]
                del body["manualMode"]  # An omitted PATCH mode preserves the saved mode.
                edited = self.client.patch(f"/api/matches/{match['id']}", json=body)
                self.assertEqual(edited.status_code, 200, edited.get_json())
                self.assertEqual([p["id"] for p in edited.get_json()["teamA"]], a)
                self.assertEqual(edited.get_json()["manualMode"], "no_roles_lock")

    def test_duplicate_members_and_synthetic_roles_rejected(self):
        body = self.body()
        body["teamBPlayerIds"][0] = body["teamAPlayerIds"][0]
        self.assertEqual(self.client.post("/api/matches", json=body).status_code, 400)
        body = self.body()
        body["teamAAssignments"] = [{"playerId": self.player_ids[0], "assignedPosition": "Setter"}]
        self.assertEqual(self.client.post("/api/matches", json=body).status_code, 400)
        body = self.body()
        body["manualMode"] = "invalid"
        self.assertEqual(self.client.post("/api/matches", json=body).status_code, 400)

    def test_elo_counts_k_and_reversal_use_normal_path(self):
        before = [self.profile(i) for i in self.player_ids]
        match = self.role_free()
        played = self.complete(match)
        self.assertEqual(len(played["eloChanges"]), 12)
        for change in played["eloChanges"]:
            self.assertEqual(change["kUsed"], 60)
            self.assertEqual(change["matchesPlayedBefore"], 0)
            self.assertEqual(change["matchesPlayedAfter"], 1)
            self.assertEqual(abs(change["changeAmount"]), 26)
        self.assertEqual(self.rows("priority_events", match["id"]), [])
        self.assertEqual(self.history(), {})
        self.assertEqual(self.client.patch(f"/api/matches/{match['id']}", json=self.body()).status_code, 409)
        self.assertEqual(self.client.post(f"/api/matches/{match['id']}/reopen").status_code, 200)
        after = [self.profile(i) for i in self.player_ids]
        for a, b in zip(before, after):
            for key in ("elo", "rank", "matchesPlayed", "provisional", "prioritySince", "preferredRolePriority"):
                self.assertEqual(a[key], b[key])
        corrected = self.complete(match)
        self.assertTrue(all(c["matchesPlayedAfter"] == 1 for c in corrected["eloChanges"]))
        self.assertEqual(self.client.delete(f"/api/matches/{match['id']}").status_code, 204)
        self.assertEqual(self.history(), {})
        self.assertEqual(self.rows("elo_history", match["id"]), [])

    def test_three_eligible_appearances_survive_role_free_games_and_corrections(self):
        target = self.player_ids[5]
        for index, rank in enumerate((4, 3, 2)):
            self.set_opposite_rank(target, rank)
            with patch("app.utc_now", return_value=f"2026-0{index + 1}-01T00:00:00.000Z"):
                self.complete(self.create_match())
        before = self.profile(target)
        for month in (4, 5):
            with patch("app.utc_now", return_value=f"2026-0{month}-01T00:00:00.000Z"):
                latest = self.role_free()
                self.complete(latest)
            self.assertEqual(self.history()[target], [2, 3, 4])
            self.assertEqual(self.profile(target)["prioritySince"], before["prioritySince"])
            self.assertEqual(self.rows("assignment_audit", latest["id"]), [])
            self.assertEqual(self.rows("priority_events", latest["id"]), [])
        self.assertEqual(self.profile(target)["matchesPlayed"], 5)
        self.assertEqual(self.client.post(f"/api/matches/{latest['id']}/reopen").status_code, 200)
        self.assertEqual(self.history()[target], [2, 3, 4])
        self.complete(latest)
        self.assertEqual(self.client.post(f"/api/matches/{latest['id']}/void").status_code, 200)
        self.assertEqual(self.history()[target], [2, 3, 4])
        initialize_database(self.app.config["DATABASE_PATH"])
        self.assertEqual(self.history()[target], [2, 3, 4])
        self.assertEqual(self.rows("priority_events", latest["id"]), [])

    def test_filled_compensation_not_awarded_or_cleared_by_role_free_match(self):
        first = self.create_match()
        self.complete(first)
        target = self.player_ids[5]  # Opposite is Filled in the normal fixture.
        before = self.profile(target)
        self.assertTrue(before["preferredRolePriority"])
        match = self.role_free()
        self.complete(match)
        self.assertEqual(self.profile(target)["prioritySince"], before["prioritySince"])
        self.assertEqual(self.client.post(f"/api/matches/{match['id']}/reopen").status_code, 200)
        self.assertEqual(self.profile(target)["prioritySince"], before["prioritySince"])

    def test_explicit_roles_lock_and_legacy_stay_compatible(self):
        legacy = self.create_match()
        self.assertIsNone(legacy["manualMode"])
        explicit = self.create_match(manualMode="roles_lock")
        self.assertEqual(explicit["manualMode"], "roles_lock")
        self.assertEqual(len(self.rows("assignment_audit", explicit["id"])), 12)
        self.complete(explicit)
        self.assertEqual(self.history()[self.player_ids[0]], [1])
        initialize_database(self.app.config["DATABASE_PATH"])
        self.assertIsNone(self.client.get(f"/api/matches/{legacy['id']}").get_json()["manualMode"])
        with sqlite3.connect(self.app.config["DATABASE_PATH"]) as db:
            cols = [r[1] for r in db.execute("PRAGMA table_info(matches)")]
            self.assertEqual(cols.count("manual_mode"), 1)

    def test_normal_authorization_and_public_redaction_preserved(self):
        match = self.role_free()
        anonymous = SignedClient(self.app, None, None)
        ordinary = SignedClient(self.app, "manual-ordinary")
        self.assertEqual(ordinary.post("/api/matches", json=self.body()).status_code, 403)
        self.assertEqual(anonymous.post("/api/matches", json=self.body()).status_code, 401)
        self.complete(match)
        public = anonymous.get(f"/api/matches/{match['id']}").get_json()
        self.assertEqual(public["eloChanges"], [])
        for p in public["teamA"] + public["teamB"]:
            self.assertIsNone(p["elo"])
            self.assertIsNone(p["assignedPosition"])

    def test_result_failure_rolls_back_without_role_side_effects(self):
        match = self.role_free()
        before = self.profile(self.player_ids[0])
        with sqlite3.connect(self.app.config["DATABASE_PATH"]) as db:
            db.execute("CREATE TRIGGER fail_role_free_result BEFORE INSERT ON elo_history BEGIN SELECT RAISE(ABORT, 'fixture failure'); END")
        self.app.config["TESTING"] = False
        response = self.client.post(f"/api/matches/{match['id']}/result", json={"scoreA": 3, "scoreB": 1})
        self.assertEqual(response.status_code, 500)
        self.assertEqual(self.profile(self.player_ids[0])["elo"], before["elo"])
        self.assertEqual(self.profile(self.player_ids[0])["matchesPlayed"], 0)
        self.assertEqual(self.rows("elo_history", match["id"]), [])
        self.assertEqual(self.rows("priority_events", match["id"]), [])
        self.assertEqual(self.history(), {})

    def test_role_free_k_boundaries_follow_completed_appearance_counts(self):
        # Reuse genuine role-free completions, rather than changing live counters.
        for number in range(1, 62):
            played = self.complete(self.role_free())
            expected_k = 60 if number <= 10 else 40 if number <= 30 else 32 if number <= 60 else 20
            self.assertTrue(all(c["kUsed"] == expected_k and c["matchesPlayedAfter"] == number for c in played["eloChanges"]))
        self.assertEqual(self.history(), {})
        self.assertFalse(self.profile(self.player_ids[0])["provisional"])
