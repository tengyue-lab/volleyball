import sqlite3
import unittest

import test_match_results as results
from auth_client import SignedClient


class CompletedMatchDateTests(unittest.TestCase):
    setUp = results.MatchResultTests.setUp
    tearDown = results.MatchResultTests.tearDown
    create_match = results.MatchResultTests.create_match
    complete = results.MatchResultTests.complete
    profile = results.MatchResultTests.profile

    def snapshot_table(self, table, order_by):
        with sqlite3.connect(self.app.config["DATABASE_PATH"]) as connection:
            return connection.execute(f"SELECT * FROM {table} ORDER BY {order_by}").fetchall()

    def test_admin_corrects_only_completed_match_date_and_preserves_rating_and_rotation_state(self):
        self.create_match(matchDate="2026-10-11")
        match = self.complete(self.create_match(matchDate="2026-10-10"))
        match_id = match["id"]
        with sqlite3.connect(self.app.config["DATABASE_PATH"]) as connection:
            connection.row_factory = sqlite3.Row
            before_match = dict(connection.execute("SELECT * FROM matches WHERE id=?", (match_id,)).fetchone())
        before_players = self.snapshot_table("players", "id")
        before_elo = self.snapshot_table("elo_history", "id")
        before_priority = self.snapshot_table("priority_events", "id")
        before_assignments = self.snapshot_table("assignment_audit", "match_id, player_id")
        before_rotation = self.client.get("/api/admin/position-rotation-history").get_json()

        response = self.client.patch(
            f"/api/matches/{match_id}/date", json={"matchDate": "2026-10-17"}
        )
        self.assertEqual(response.status_code, 200, response.get_json())
        updated = response.get_json()
        self.assertEqual(updated["matchDate"], "2026-10-17")
        self.assertEqual(updated["status"], "completed")
        self.assertEqual((updated["scoreA"], updated["scoreB"], updated["winner"]),
                         (match["scoreA"], match["scoreB"], match["winner"]))
        self.assertEqual(updated["teamA"], match["teamA"])
        self.assertEqual(updated["teamB"], match["teamB"])

        with sqlite3.connect(self.app.config["DATABASE_PATH"]) as connection:
            connection.row_factory = sqlite3.Row
            after_match = dict(connection.execute("SELECT * FROM matches WHERE id=?", (match_id,)).fetchone())
        self.assertEqual(
            {key: value for key, value in before_match.items() if key != "match_date"},
            {key: value for key, value in after_match.items() if key != "match_date"},
        )
        self.assertEqual(after_match["match_date"], "2026-10-17")
        self.assertEqual(before_players, self.snapshot_table("players", "id"))
        self.assertEqual(before_elo, self.snapshot_table("elo_history", "id"))
        self.assertEqual(before_priority, self.snapshot_table("priority_events", "id"))
        self.assertEqual(before_assignments, self.snapshot_table("assignment_audit", "match_id, player_id"))
        self.assertEqual(before_rotation, self.client.get("/api/admin/position-rotation-history").get_json())
        self.assertEqual(
            self.client.get(f"/api/matches/{match_id}").get_json()["matchDate"],
            "2026-10-17",
        )
        self.assertEqual(
            [self.profile(player_id)["matchesPlayed"] for player_id in self.player_ids],
            [1] * len(self.player_ids),
        )
        reopened = self.client.post(f"/api/matches/{match_id}/reopen")
        self.assertEqual(reopened.status_code, 200)
        self.assertEqual(reopened.get_json()["matchDate"], "2026-10-17")

    def test_non_admin_and_anonymous_clients_cannot_correct_a_completed_match(self):
        match = self.complete(self.create_match(matchDate="2026-10-10"))
        body = {"matchDate": "2026-10-17"}
        ordinary = SignedClient(self.app, "user_test_owner", "owner@example.test")
        self.assertEqual(ordinary.patch(f"/api/matches/{match['id']}/date", json=body).status_code, 403)
        anonymous = SignedClient(self.app, None, None)
        self.assertEqual(anonymous.patch(f"/api/matches/{match['id']}/date", json=body).status_code, 401)
        self.assertEqual(
            self.client.get(f"/api/matches/{match['id']}").get_json()["matchDate"],
            "2026-10-10",
        )

    def test_invalid_payloads_unknown_matches_and_uncompleted_matches_are_rejected_unchanged(self):
        upcoming = self.create_match(matchDate="2026-10-10")
        endpoint = f"/api/matches/{upcoming['id']}/date"
        self.assertEqual(self.client.patch(endpoint, json={"matchDate": "2026-10-17"}).status_code, 409)

        completed = self.complete(self.create_match(matchDate="2026-10-11"))
        endpoint = f"/api/matches/{completed['id']}/date"
        for payload in (
            {},
            {"matchDate": "2026-02-29"},
            {"matchDate": "2026-10-17T00:00:00"},
            {"matchDate": "2026-10-17", "scoreA": 3},
            {"matchDate": None},
        ):
            with self.subTest(payload=payload):
                self.assertEqual(self.client.patch(endpoint, json=payload).status_code, 400)
                self.assertEqual(
                    self.client.get(f"/api/matches/{completed['id']}").get_json()["matchDate"],
                    "2026-10-11",
                )
        self.assertEqual(self.client.patch("/api/matches/99999/date", json={"matchDate": "2026-10-17"}).status_code, 404)
        self.assertEqual(
            self.client.patch("/api/matches/not-an-id/date", json={"matchDate": "2026-10-17"}).status_code,
            404,
        )

    def test_voided_match_date_cannot_be_rewritten(self):
        completed = self.complete(self.create_match(matchDate="2026-10-12"))
        self.assertEqual(self.client.post(f"/api/matches/{completed['id']}/void").status_code, 200)
        response = self.client.patch(
            f"/api/matches/{completed['id']}/date", json={"matchDate": "2026-10-17"}
        )
        self.assertEqual(response.status_code, 409)
        self.assertEqual(
            self.client.get(f"/api/matches/{completed['id']}").get_json()["matchDate"],
            "2026-10-12",
        )
