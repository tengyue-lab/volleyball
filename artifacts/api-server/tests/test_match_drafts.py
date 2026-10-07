"""Draft-only mutations cannot erase played matches or their audit trail."""
import concurrent.futures
import sqlite3
import unittest

import test_match_results as results
from auth_client import SignedClient


class MatchDraftTests(unittest.TestCase):
    setUp = results.MatchResultTests.setUp
    tearDown = results.MatchResultTests.tearDown
    create_match = results.MatchResultTests.create_match
    complete = results.MatchResultTests.complete

    def body(self, match, **changes):
        result = {
            "teamAPlayerIds": [p["id"] for p in match["teamA"]],
            "teamBPlayerIds": [p["id"] for p in match["teamB"]],
            "teamAAssignments": [
                {"playerId": p["id"], "assignedPosition": p["assignedPosition"]}
                for p in match["teamA"]
            ],
            "teamBAssignments": [
                {"playerId": p["id"], "assignedPosition": p["assignedPosition"]}
                for p in match["teamB"]
            ],
            "matchDate": "2026-10-08",
        }
        return {**result, **changes}

    def snapshot(self):
        with sqlite3.connect(self.app.config["DATABASE_PATH"]) as db:
            return {
                table: db.execute(f"SELECT * FROM {table} ORDER BY 1, 2").fetchall()
                for table in ("players", "elo_history", "priority_events", "assignment_audit")
            }

    def test_reset_removes_only_target_and_its_assignments_without_rating_changes(self):
        completed = self.complete(self.create_match())
        draft = self.create_match()
        other = self.create_match()
        before = self.snapshot()
        response = self.client.delete(f"/api/matches/{draft['id']}")
        self.assertEqual(response.status_code, 204)
        after = self.snapshot()
        for table in ("players", "elo_history", "priority_events"):
            self.assertEqual(after[table], before[table])
        self.assertEqual(after["assignment_audit"], [
            row for row in before["assignment_audit"] if row[0] != draft["id"]
        ])
        self.assertEqual(self.client.get(f"/api/matches/{draft['id']}").status_code, 404)
        self.assertEqual(self.client.get(f"/api/matches/{completed['id']}").get_json(), completed)
        self.assertEqual(self.client.get(f"/api/matches/{other['id']}").get_json(), other)
        self.assertEqual(
            [m["id"] for m in self.client.get("/api/matches").get_json() if m["status"] == "upcoming"],
            [other["id"]],
        )
        self.assertEqual(self.client.delete(f"/api/matches/{other['id']}").status_code, 204)
        self.assertFalse(any(m["status"] == "upcoming" for m in self.client.get("/api/matches").get_json()))

    def test_edit_reuses_id_and_creation_date_with_live_profiles_and_assignments(self):
        match = self.create_match(matchDate="2026-10-07")
        body = self.body(match)
        # Swap two players' roles and ensure operational metadata follows them.
        assignments = body["teamAAssignments"]
        assignments[0]["assignedPosition"], assignments[1]["assignedPosition"] = (
            assignments[1]["assignedPosition"], assignments[0]["assignedPosition"]
        )
        self.client.patch(f"/api/players/{self.player_ids[0]}", json={"elo": 1234, "name": "Updated"})
        before = self.snapshot()
        response = self.client.patch(f"/api/matches/{match['id']}", json=body)
        self.assertEqual(response.status_code, 200, response.get_json())
        edited = response.get_json()
        self.assertEqual(edited["id"], match["id"])
        self.assertEqual(edited["createdAt"], match["createdAt"])
        self.assertEqual(edited["matchDate"], "2026-10-08")
        self.assertEqual(edited["teamA"][0]["elo"], 1234)
        self.assertEqual(edited["teamA"][0]["name"], "Updated")
        self.assertEqual(edited["teamA"][0]["assignedPosition"], "Outside Hitter")
        self.assertTrue(edited["draftEditable"])
        self.assertEqual(len(self.client.get("/api/matches").get_json()), 1)
        after = self.snapshot()
        for table in ("players", "elo_history", "priority_events"):
            self.assertEqual(after[table], before[table])
        with sqlite3.connect(self.app.config["DATABASE_PATH"]) as db:
            self.assertEqual(db.execute(
                "SELECT position, status, preference_rank FROM assignment_audit WHERE match_id=? AND player_id=?",
                (match["id"], self.player_ids[0]),
            ).fetchone(), ("Outside Hitter", "preferred", 2))
        self.complete(edited)
        with sqlite3.connect(self.app.config["DATABASE_PATH"]) as db:
            self.assertEqual(db.execute(
                "SELECT status FROM priority_events WHERE match_id=? AND player_id=?",
                (match["id"], self.player_ids[0]),
            ).fetchone()[0], "preferred")

    def test_completed_and_reopened_history_still_reject_edit(self):
        match = self.create_match()
        completed = self.complete(match)
        self.assertFalse(completed["draftEditable"])
        for current in (completed, self.client.post(f"/api/matches/{match['id']}/reopen").get_json()):
            before = self.snapshot()
            self.assertFalse(current["draftEditable"])
            self.assertEqual(self.client.patch(f"/api/matches/{match['id']}", json=self.body(match)).status_code, 409)
            self.assertEqual(self.snapshot(), before)

    def test_history_evidence_is_guarded_even_when_snapshot_looks_unplayed(self):
        match = self.create_match()
        with sqlite3.connect(self.app.config["DATABASE_PATH"]) as db:
            db.execute(
                "INSERT INTO priority_events(match_id,player_id,status,created_at,active) VALUES(?,?,?,'2026-01-01',0)",
                (match["id"], self.player_ids[0], "filled"),
            )
        self.assertFalse(self.client.get(f"/api/matches/{match['id']}").get_json()["draftEditable"])
        self.assertEqual(self.client.patch(f"/api/matches/{match['id']}", json=self.body(match)).status_code, 409)
        self.assertEqual(self.client.delete(f"/api/matches/{match['id']}").status_code, 204)

    def test_admin_gate_and_missing_ids(self):
        match = self.create_match()
        normal = SignedClient(self.app, user_id="user_normal_draft", email="normal-draft@example.test")
        self.assertEqual(normal.delete(f"/api/matches/{match['id']}").status_code, 403)
        self.assertEqual(normal.patch(f"/api/matches/{match['id']}", json=self.body(match)).status_code, 403)
        self.assertEqual(self.app.test_client().delete(f"/api/matches/{match['id']}").status_code, 403)
        self.assertEqual(self.client.delete("/api/matches/999999").status_code, 404)
        self.assertEqual(self.client.patch("/api/matches/999999", json=self.body(match)).status_code, 404)
        self.assertEqual(self.client.get(f"/api/matches/{match['id']}").status_code, 200)

    def test_invalid_edit_is_atomic_and_preserves_snapshot(self):
        match = self.create_match()
        before = self.snapshot()
        for body in (
            self.body(match, matchDate="2026-02-29"),
            self.body(match, teamAPlayerIds=[9999] + self.player_ids[1:6]),
            self.body(match, teamAAssignments=[]),
            self.body(match, teamBPlayerIds=self.player_ids[:6]),
        ):
            self.assertEqual(self.client.patch(f"/api/matches/{match['id']}", json=body).status_code, 400)
            self.assertEqual(self.client.get(f"/api/matches/{match['id']}").get_json(), match)
            self.assertEqual(self.snapshot(), before)

    def test_completion_racing_reset_cannot_delete_completed_result(self):
        match = self.create_match()
        # Both operations serialize on BEGIN IMMEDIATE. Either reset wins before
        # play, or result wins and reset must reject, never erase applied ELO.
        def complete():
            return SignedClient(self.app).post(
                f"/api/matches/{match['id']}/result", json={"scoreA": 3, "scoreB": 1}
            ).status_code
        def remove():
            return SignedClient(self.app).delete(f"/api/matches/{match['id']}?expectedStatus=upcoming").status_code
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            result = executor.submit(complete)
            deletion = executor.submit(remove)
            statuses = result.result(), deletion.result()
        self.assertIn(statuses, [(200, 409), (404, 204)])
        with sqlite3.connect(self.app.config["DATABASE_PATH"]) as db:
            rows = db.execute("SELECT * FROM elo_history WHERE match_id=?", (match["id"],)).fetchall()
            saved = db.execute("SELECT status FROM matches WHERE id=?", (match["id"],)).fetchone()
            if statuses[0] == 200:
                self.assertEqual(len(rows), 12)
                self.assertEqual(saved[0], "completed")
            else:
                self.assertEqual(rows, [])
                self.assertIsNone(saved)
