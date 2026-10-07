import sys
import tempfile
import unittest
import json
import sqlite3
from pathlib import Path


API_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(API_DIR))

from app import calculate_elo_updates, create_app, initialize_database, replay_priority  # noqa: E402
from auth_client import SignedClient


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
        self.client = SignedClient(self.app)
        self.player_ids = []
        for index in range(12):
            elo = 1050 if index < 6 else 1000
            response = self.client.post(
                "/api/players",
                json={
                    "name": f"Player {index + 1}",
                    "positions": ["Setter", "Outside Hitter", "Middle Blocker"],
                    "elo": elo,
                },
            )
            self.assertEqual(response.status_code, 201)
            self.player_ids.append(response.get_json()["id"])

    def tearDown(self):
        self.temp_dir.cleanup()

    def create_match(self, **extra_fields):
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
        body.update(extra_fields)
        response = self.client.post("/api/matches", json=body)
        self.assertEqual(response.status_code, 201, response.get_json())
        return response.get_json()

    def player_elo(self, player_id):
        response = self.client.get(f"/api/players/{player_id}")
        self.assertEqual(response.status_code, 200)
        return response.get_json()["elo"]

    def test_match_date_is_saved_separately_and_survives_result_and_reversal(self):
        match = self.create_match(matchDate="2026-10-07")
        self.assertEqual(match["matchDate"], "2026-10-07")
        self.assertNotEqual(match["createdAt"], match["matchDate"])
        completed = self.complete(match)
        self.assertEqual(completed["matchDate"], match["matchDate"])
        reopened = self.client.post(f"/api/matches/{match['id']}/reopen").get_json()
        self.assertEqual(reopened["matchDate"], match["matchDate"])
        self.assertEqual(reopened["teamA"], match["teamA"])

    def test_existing_match_creation_without_date_remains_compatible(self):
        self.assertIsNone(self.create_match()["matchDate"])

    def test_invalid_match_dates_do_not_create_a_roster(self):
        match = self.create_match()
        body = {
            "teamAPlayerIds": self.player_ids[:6], "teamBPlayerIds": self.player_ids[6:],
            "teamAAssignments": [{"playerId": p["id"], "assignedPosition": p["assignedPosition"]} for p in match["teamA"]],
            "teamBAssignments": [{"playerId": p["id"], "assignedPosition": p["assignedPosition"]} for p in match["teamB"]],
        }
        for invalid in ("", "2026-02-29", "2026-13-01", "20261007", None, 20261007, True):
            response = self.client.post("/api/matches", json={**body, "matchDate": invalid})
            self.assertEqual(response.status_code, 400)
            self.assertIn("Match date", response.get_json()["error"])
        self.assertEqual(len(self.client.get("/api/matches").get_json()), 1)

    def test_calculation_uses_team_average_and_established_k_factor_32(self):
        team_a = [{"id": 1, "elo": 1000, "matchesPlayed": 30}, {"id": 2, "elo": 1000, "matchesPlayed": 30}]
        team_b = [{"id": 3, "elo": 1000, "matchesPlayed": 30}, {"id": 4, "elo": 1000, "matchesPlayed": 30}]

        updates = calculate_elo_updates(team_a, team_b, "Team A")

        self.assertEqual(
            [{key: update[key] for key in ("playerId", "eloBefore", "eloAfter", "changeAmount")} for update in updates],
            [
                {"playerId": 1, "eloBefore": 1000, "eloAfter": 1016, "changeAmount": 16},
                {"playerId": 2, "eloBefore": 1000, "eloAfter": 1016, "changeAmount": 16},
                {"playerId": 3, "eloBefore": 1000, "eloAfter": 984, "changeAmount": -16},
                {"playerId": 4, "eloBefore": 1000, "eloAfter": 984, "changeAmount": -16},
            ],
        )
        self.assertTrue(all(update["kUsed"] == 32 for update in updates))
        self.assertTrue(all(update["matchesPlayedAfter"] == 31 for update in updates))

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
        self.assertTrue(all(row["changeAmount"] == 26 for row in result["eloChanges"][:6]))
        self.assertTrue(all(row["changeAmount"] == -26 for row in result["eloChanges"][6:]))
        self.assertEqual(self.player_elo(self.player_ids[0]), 1076)
        self.assertEqual(self.player_elo(self.player_ids[6]), 974)

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
        self.assertEqual(full_history[1]["eloBefore"], 1076)
        self.assertEqual(full_history[1]["eloAfter"], 1050)
        self.assertEqual(full_history[1]["changeAmount"], -26)

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
        self.assertEqual(self.player_elo(self.player_ids[0]), 1037)

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

    def complete(self, match):
        response = self.client.post(f"/api/matches/{match['id']}/result", json={"scoreA": 3, "scoreB": 1})
        self.assertEqual(response.status_code, 200, response.get_json())
        return response.get_json()

    def profile(self, player_id):
        return self.client.get(f"/api/players/{player_id}").get_json()

    def test_ranked_positions_round_trip_and_validation(self):
        ranks = ["Libero", "Opposite", "Setter", "Middle Blocker", "Outside Hitter"]
        player_id = self.player_ids[0]
        for n in [1, 2, 3, 4, 5]:
            response = self.client.patch(f"/api/players/{player_id}", json={"positions": ranks[:n]})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(self.profile(player_id)["positions"], ranks[:n])
            self.assertTrue(response.get_json()["preferencesConfirmed"])
        for bad in [[], ["Setter", "Setter", "Libero"], ["Setter", "Libero", "Nope"], ranks + ["Setter"]]:
            self.assertEqual(self.client.patch(f"/api/players/{player_id}", json={"positions": bad}).status_code, 400)
            self.assertEqual(self.client.post("/api/players", json={"name": "Invalid", "positions": bad}).status_code, 400)

    def test_single_preference_create_edit_matching_and_filled_priority(self):
        created = self.client.post("/api/players", json={"name": "One preference", "positions": ["Setter"]})
        self.assertEqual(created.status_code, 201)
        self.assertEqual(created.get_json()["positions"], ["Setter"])
        self.assertTrue(created.get_json()["preferencesConfirmed"])
        for player_id in self.player_ids:
            updated = self.client.patch(f"/api/players/{player_id}", json={"positions": ["Setter"]})
            self.assertEqual(updated.status_code, 200)
        match = self.create_match()
        target = self.player_ids[5]
        self.assertEqual(match["teamA"][5]["assignmentStatus"], "filled")
        self.assertIsNone(match["teamA"][5]["preferenceRank"])
        self.assertFalse(self.profile(target)["preferredRolePriority"])
        self.complete(match)
        self.assertTrue(self.profile(target)["preferredRolePriority"])
        self.client.patch(f"/api/players/{target}", json={"positions": ["Opposite"]})
        preferred = self.create_match()
        self.assertEqual(preferred["teamA"][5]["preferenceRank"], 1)
        self.assertTrue(self.profile(target)["preferredRolePriority"])
        self.complete(preferred)
        self.assertFalse(self.profile(target)["preferredRolePriority"])
        self.assertEqual(self.client.post(f"/api/matches/{preferred['id']}/reopen").status_code, 200)
        self.assertTrue(self.profile(target)["preferredRolePriority"])

    def test_saved_snapshot_audit_no_priority_until_completion(self):
        match = self.create_match()
        target = self.player_ids[5]
        snapshot = match["teamA"][5]
        self.assertEqual(snapshot["assignmentStatus"], "filled")
        self.assertIsNone(snapshot["preferenceRank"])
        self.assertEqual(match["teamA"][0]["preferenceRank"], 1)
        self.assertFalse(self.profile(target)["preferredRolePriority"])
        with sqlite3.connect(self.app.config["DATABASE_PATH"]) as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM assignment_audit").fetchone()[0], 12)
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM priority_events").fetchone()[0], 0)
        # Current preference edits cannot retroactively change played status.
        self.client.patch(f"/api/players/{target}", json={"positions": ["Opposite", "Setter", "Libero"]})
        completed = self.complete(match)
        self.assertEqual(completed["teamA"], match["teamA"])
        self.assertTrue(self.profile(target)["preferredRolePriority"])
        next_match = self.create_match()
        self.assertEqual(next_match["teamA"][5]["assignmentStatus"], "preferred")
        self.assertTrue(self.profile(target)["preferredRolePriority"])
        self.complete(next_match)
        self.assertFalse(self.profile(target)["preferredRolePriority"])
        self.assertIsNone(self.profile(target)["prioritySince"])
        self.assertEqual(self.client.post(f"/api/matches/{next_match['id']}/reopen").status_code, 200)
        self.assertTrue(self.profile(target)["preferredRolePriority"])
        self.assertEqual(self.client.post(f"/api/matches/{match['id']}/reopen").status_code, 200)
        self.assertFalse(self.profile(target)["preferredRolePriority"])

    def test_repeated_filled_retains_earliest_wait_and_duplicate_result_is_locked(self):
        target = self.player_ids[5]
        first = self.create_match()
        self.complete(first)
        since = self.profile(target)["prioritySince"]
        second = self.create_match()
        self.complete(second)
        self.assertEqual(self.profile(target)["prioritySince"], since)
        duplicate = self.client.post(f"/api/matches/{second['id']}/result", json={"scoreA": 3, "scoreB": 0})
        self.assertEqual(duplicate.status_code, 409)
        with sqlite3.connect(self.app.config["DATABASE_PATH"]) as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM priority_events").fetchone()[0], 24)
        self.assertEqual(self.client.post(f"/api/matches/{first['id']}/reopen").status_code, 409)
        self.assertEqual(self.profile(target)["prioritySince"], since)
        self.assertEqual(self.client.post(f"/api/matches/{second['id']}/reopen").status_code, 200)
        self.assertEqual(self.profile(target)["prioritySince"], since)

    def test_completion_order_not_roster_order_and_reload_persists_priority(self):
        target = self.player_ids[5]
        filled = self.create_match()
        self.client.patch(f"/api/players/{target}", json={"positions": ["Opposite", "Setter", "Libero"]})
        preferred = self.create_match()
        self.complete(preferred)
        self.complete(filled)
        self.assertTrue(self.profile(target)["preferredRolePriority"])
        reopened_app = create_app(self.app.config["DATABASE_PATH"])
        self.assertTrue(SignedClient(reopened_app).get(f"/api/players/{target}").get_json()["preferredRolePriority"])
        self.assertEqual(self.client.post(f"/api/matches/{filled['id']}/reopen").status_code, 200)
        self.assertFalse(self.profile(target)["preferredRolePriority"])

    def test_historical_completion_backfill_uses_actual_order_and_is_idempotent(self):
        target = self.player_ids[5]
        first = self.create_match()
        self.complete(first)
        self.client.patch(f"/api/players/{target}", json={"positions": ["Opposite", "Setter", "Libero"]})
        second = self.create_match()
        self.complete(second)
        with sqlite3.connect(self.app.config["DATABASE_PATH"]) as conn:
            # Simulate an older completed roster predating compensation events.
            conn.execute("DELETE FROM priority_events WHERE match_id=?", (first["id"],))
        initialize_database(self.app.config["DATABASE_PATH"])
        initialize_database(self.app.config["DATABASE_PATH"])
        # Backfilled rows were inserted later but belong earlier in actual play.
        self.assertFalse(self.profile(target)["preferredRolePriority"])
        with sqlite3.connect(self.app.config["DATABASE_PATH"]) as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM priority_events").fetchone()[0], 24)
        self.assertEqual(self.client.post(f"/api/matches/{second['id']}/reopen").status_code, 200)
        self.assertTrue(self.profile(target)["preferredRolePriority"])

    def test_priority_replay_preserves_later_active_effects(self):
        target = self.player_ids[5]
        with sqlite3.connect(self.app.config["DATABASE_PATH"]) as conn:
            conn.row_factory = sqlite3.Row
            for match_id, status, timestamp in [(1, "filled", "2026-01-01"), (2, "preferred", "2026-01-02"), (3, "filled", "2026-01-03")]:
                conn.execute("INSERT INTO priority_events (match_id,player_id,status,created_at) VALUES (?,?,?,?)", (match_id,target,status,timestamp))
            conn.execute("UPDATE priority_events SET active=0 WHERE match_id=1")
            replay_priority(conn, [target])
        self.assertEqual(self.profile(target)["prioritySince"], "2026-01-03")

    def test_new_matches_gate_legacy_and_zero_setter_but_allow_one(self):
        match = self.create_match()
        body = {
            "teamAPlayerIds": self.player_ids[:6], "teamBPlayerIds": self.player_ids[6:],
            "teamAAssignments": [{"playerId":p["id"],"assignedPosition":p["assignedPosition"]} for p in match["teamA"]],
            "teamBAssignments": [{"playerId":p["id"],"assignedPosition":p["assignedPosition"]} for p in match["teamB"]],
        }
        with sqlite3.connect(self.app.config["DATABASE_PATH"]) as conn:
            conn.execute("UPDATE players SET preferences_confirmed=0 WHERE id=?", (self.player_ids[0],))
        self.assertEqual(self.client.post("/api/matches", json=body).status_code, 400)
        self.client.patch(f"/api/players/{self.player_ids[0]}", json={"positions":["Setter","Libero","Opposite"]})
        for p in self.player_ids[1:]:
            self.client.patch(f"/api/players/{p}", json={"positions":["Outside Hitter","Middle Blocker","Opposite"]})
        self.assertEqual(self.client.post("/api/matches", json=body).status_code, 201)
        self.client.patch(f"/api/players/{self.player_ids[0]}", json={"positions":["Outside Hitter","Middle Blocker","Opposite"]})
        self.assertEqual(self.client.post("/api/matches", json=body).status_code, 400)

    def test_assignment_metadata_cannot_lie_and_ids_are_distinct(self):
        match = self.create_match()
        body = {
            "teamAPlayerIds": self.player_ids[:6], "teamBPlayerIds": self.player_ids[6:],
            "teamAAssignments": [{"playerId":p["id"],"assignedPosition":p["assignedPosition"],"assignmentStatus":p["assignmentStatus"],"preferenceRank":p["preferenceRank"]} for p in match["teamA"]],
            "teamBAssignments": [{"playerId":p["id"],"assignedPosition":p["assignedPosition"]} for p in match["teamB"]],
        }
        body["teamAAssignments"][5]["assignmentStatus"] = "preferred"
        self.assertEqual(self.client.post("/api/matches", json=body).status_code, 400)
        body["teamAAssignments"][5]["assignmentStatus"] = "filled"
        body["teamAAssignments"][0]["preferenceRank"] = 3
        self.assertEqual(self.client.post("/api/matches", json=body).status_code, 400)
        body["teamAAssignments"][0]["preferenceRank"] = 1
        body["teamBPlayerIds"][0] = self.player_ids[0]
        self.assertEqual(self.client.post("/api/matches", json=body).status_code, 400)

    def test_delete_player_preserves_snapshot_and_priority_audit(self):
        match = self.create_match()
        self.complete(match)
        target = self.player_ids[5]
        self.assertEqual(self.client.delete(f"/api/players/{target}").status_code, 204)
        self.assertEqual(self.client.get(f"/api/matches/{match['id']}").get_json()["teamA"], match["teamA"])
        with sqlite3.connect(self.app.config["DATABASE_PATH"]) as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM assignment_audit WHERE player_id=?", (target,)).fetchone()[0], 1)

    def test_13_and_14_exact_roles_with_filled_libero(self):
        ids = list(self.player_ids)
        for extra in [13, 14]:
            new = self.client.post("/api/players", json={"name": f"Extra {extra}", "positions":["Setter","Outside Hitter","Middle Blocker"]}).get_json()
            ids.append(new["id"])
            a = ids[:6] + ([ids[12]] if extra == 14 else [])
            b = ids[6:12] + [ids[-1]]
            body = {"teamAPlayerIds": a, "teamBPlayerIds": b,
                "teamAAssignments": [{"playerId":p,"assignedPosition":r} for p,r in zip(a,ROLE_FORMATION + ["Libero"])],
                "teamBAssignments": [{"playerId":p,"assignedPosition":r} for p,r in zip(b,ROLE_FORMATION + ["Libero"])]}
            response = self.client.post("/api/matches", json=body)
            self.assertEqual(response.status_code, 201, response.get_json())
            self.assertEqual(response.get_json()["teamB"][-1]["assignmentStatus"], "filled")


class MigrationTests(unittest.TestCase):
    def test_additive_legacy_migration_preserves_lists_and_snapshots(self):
        with tempfile.TemporaryDirectory() as temp:
            path = str(Path(temp) / "legacy.sqlite3")
            original_positions = ["Libero", "Setter"]
            snapshot = [{"id":1, "name":"Legacy", "positions":original_positions, "elo":1000, "assignedPosition":"Opposite"}]
            with sqlite3.connect(path) as conn:
                conn.executescript("""
                    CREATE TABLE players (id INTEGER PRIMARY KEY, name TEXT, positions_json TEXT, elo INTEGER, created_at TEXT);
                    CREATE TABLE matches (id INTEGER PRIMARY KEY, team_a_json TEXT, team_b_json TEXT, score_a INTEGER, score_b INTEGER, status TEXT, created_at TEXT);
                """)
                conn.execute("INSERT INTO players VALUES (1, 'Legacy', ?, 1000, '2026-01-01')", (json.dumps(original_positions),))
                conn.execute("INSERT INTO matches VALUES (1, ?, '[]', NULL, NULL, 'upcoming', '2026-01-01')", (json.dumps(snapshot),))
            initialize_database(path)
            initialize_database(path)
            client = SignedClient(create_app(path))
            self.assertEqual(client.get("/api/players/1").get_json()["positions"], original_positions)
            self.assertTrue(client.get("/api/players/1").get_json()["eloPublic"])
            self.assertEqual(client.get("/api/players/1").get_json()["elo"], 1000)
            self.assertFalse(client.get("/api/players/1").get_json()["preferencesConfirmed"])
            self.assertEqual(client.get("/api/matches/1").get_json()["teamA"], snapshot)
            self.assertIsNone(client.get("/api/matches/1").get_json()["matchDate"])
            with sqlite3.connect(path) as conn:
                self.assertEqual(conn.execute("SELECT status FROM assignment_audit").fetchone()[0], "filled")


if __name__ == "__main__":
    unittest.main()
