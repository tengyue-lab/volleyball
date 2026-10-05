import sys
import tempfile
import unittest
from pathlib import Path


API_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(API_DIR))

from app import calculate_elo_updates, create_app  # noqa: E402


ROLE_FORMATION = [
    "Setter",
    "Outside Hitter",
    "Outside Hitter",
    "Middle Blocker",
    "Middle Blocker",
    "Opposite",
]


class MatchResultTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        database_path = Path(self.temp_dir.name) / "volleyball-test.sqlite3"
        self.app = create_app(database_path)
        self.client = self.app.test_client()
        self.player_ids = []
        for index in range(12):
            elo = 1050 if index < 6 else 1000
            response = self.client.post(
                "/api/players",
                json={
                    "name": f"Player {index + 1}",
                    "positions": ["Setter"],
                    "elo": elo,
                },
            )
            self.assertEqual(response.status_code, 201)
            self.player_ids.append(response.get_json()["id"])

    def tearDown(self):
        self.temp_dir.cleanup()

    def create_match(self):
        team_a = self.player_ids[:6]
        team_b = self.player_ids[6:]
        body = {
            "teamAPlayerIds": team_a,
            "teamBPlayerIds": team_b,
            "teamAAssignments": [
                {"playerId": player_id, "assignedPosition": role}
                for player_id, role in zip(team_a, ROLE_FORMATION)
            ],
            "teamBAssignments": [
                {"playerId": player_id, "assignedPosition": role}
                for player_id, role in zip(team_b, ROLE_FORMATION)
            ],
        }
        response = self.client.post("/api/matches", json=body)
        self.assertEqual(response.status_code, 201, response.get_json())
        return response.get_json()

    def player_elo(self, player_id):
        response = self.client.get(f"/api/players/{player_id}")
        self.assertEqual(response.status_code, 200)
        return response.get_json()["elo"]

    def test_calculation_uses_team_average_and_k_factor_32(self):
        team_a = [{"id": 1, "elo": 1000}, {"id": 2, "elo": 1000}]
        team_b = [{"id": 3, "elo": 1000}, {"id": 4, "elo": 1000}]

        updates = calculate_elo_updates(team_a, team_b, "Team A")

        self.assertEqual(
            updates,
            [
                {"playerId": 1, "eloBefore": 1000, "eloAfter": 1016, "changeAmount": 16},
                {"playerId": 2, "eloBefore": 1000, "eloAfter": 1016, "changeAmount": 16},
                {"playerId": 3, "eloBefore": 1000, "eloAfter": 984, "changeAmount": -16},
                {"playerId": 4, "eloBefore": 1000, "eloAfter": 984, "changeAmount": -16},
            ],
        )

    def test_tie_is_rejected_without_changing_match_or_ratings(self):
        match = self.create_match()

        response = self.client.post(
            f"/api/matches/{match['id']}/result", json={"scoreA": 2, "scoreB": 2}
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.player_elo(self.player_ids[0]), 1050)
        saved_match = self.client.get(f"/api/matches/{match['id']}").get_json()
        self.assertEqual(saved_match["status"], "upcoming")
        self.assertIsNone(saved_match["scoreA"])

    def test_result_updates_elo_and_reopen_reverses_it(self):
        match = self.create_match()

        response = self.client.post(
            f"/api/matches/{match['id']}/result", json={"scoreA": 3, "scoreB": 1}
        )

        self.assertEqual(response.status_code, 200, response.get_json())
        result = response.get_json()
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["winner"], "Team A")
        self.assertEqual((result["scoreA"], result["scoreB"]), (3, 1))
        self.assertIsNotNone(result["completedAt"])
        self.assertEqual(len(result["eloChanges"]), 12)
        self.assertTrue(all(row["changeAmount"] == 14 for row in result["eloChanges"][:6]))
        self.assertTrue(all(row["changeAmount"] == -14 for row in result["eloChanges"][6:]))
        self.assertEqual(self.player_elo(self.player_ids[0]), 1064)
        self.assertEqual(self.player_elo(self.player_ids[6]), 986)

        locked = self.client.post(
            f"/api/matches/{match['id']}/result", json={"scoreA": 1, "scoreB": 3}
        )
        self.assertEqual(locked.status_code, 409)

        player_history = self.client.get(
            f"/api/players/{self.player_ids[0]}/elo-history"
        )
        self.assertEqual(player_history.status_code, 200)
        self.assertEqual(len(player_history.get_json()), 1)
        self.assertEqual(player_history.get_json()[0]["matchId"], match["id"])

        reopened = self.client.post(f"/api/matches/{match['id']}/reopen")
        self.assertEqual(reopened.status_code, 200, reopened.get_json())
        reopened_match = reopened.get_json()
        self.assertEqual(reopened_match["status"], "upcoming")
        self.assertIsNone(reopened_match["winner"])
        self.assertIsNone(reopened_match["completedAt"])
        self.assertIsNone(reopened_match["scoreA"])
        self.assertEqual(reopened_match["eloChanges"], [])
        self.assertEqual(self.player_elo(self.player_ids[0]), 1050)
        self.assertEqual(self.player_elo(self.player_ids[6]), 1000)

        full_history = self.client.get(
            f"/api/players/{self.player_ids[0]}/elo-history"
        ).get_json()
        self.assertEqual([entry["action"] for entry in full_history], ["result", "reversal"])
        self.assertEqual(full_history[1]["eloBefore"], 1064)
        self.assertEqual(full_history[1]["eloAfter"], 1050)
        self.assertEqual(full_history[1]["changeAmount"], -14)

    def test_later_match_must_be_reversed_before_an_earlier_result(self):
        first_match = self.create_match()
        self.client.post(
            f"/api/matches/{first_match['id']}/result",
            json={"scoreA": 3, "scoreB": 1},
        )
        second_match = self.create_match()
        self.client.post(
            f"/api/matches/{second_match['id']}/result",
            json={"scoreA": 1, "scoreB": 3},
        )

        blocked = self.client.post(f"/api/matches/{first_match['id']}/reopen")
        self.assertEqual(blocked.status_code, 409)
        self.assertEqual(self.player_elo(self.player_ids[0]), 1046)

        reverse_second = self.client.post(f"/api/matches/{second_match['id']}/reopen")
        self.assertEqual(reverse_second.status_code, 200)
        reverse_first = self.client.post(f"/api/matches/{first_match['id']}/reopen")
        self.assertEqual(reverse_first.status_code, 200)
        self.assertEqual(self.player_elo(self.player_ids[0]), 1050)

    def test_scores_must_be_nonnegative_integers(self):
        match = self.create_match()

        for payload in (
            {"scoreA": -1, "scoreB": 0},
            {"scoreA": 1.5, "scoreB": 0},
            {"scoreA": True, "scoreB": 0},
        ):
            with self.subTest(payload=payload):
                response = self.client.post(
                    f"/api/matches/{match['id']}/result", json=payload
                )
                self.assertEqual(response.status_code, 400)


if __name__ == "__main__":
    unittest.main()
