"""Progression regressions use isolated SQLite databases, never the club's data."""

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

import test_match_results as results
from app import calculate_elo_updates, create_app, initialize_database
from auth_client import SignedClient
from rating_progression import k_for_matches, rank_for_elo, rank_movement


class RatingRulesTests(unittest.TestCase):
    def test_all_rank_boundaries_and_masters_label(self):
        thresholds = [
            (0, "Iron 3"), (600, "Iron 2"), (700, "Iron 1"),
            (800, "Bronze 3"), (900, "Bronze 2"), (1000, "Bronze 1"),
            (1100, "Silver 3"), (1200, "Silver 2"), (1300, "Silver 1"),
            (1400, "Gold 3"), (1500, "Gold 2"), (1600, "Gold 1"),
            (1700, "Platinum 3"), (1800, "Platinum 2"), (1900, "Platinum 1"),
            (2000, "Diamond 3"), (2100, "Diamond 2"), (2200, "Diamond 1"),
            (2300, "Masters"),
        ]
        for index, (minimum, label) in enumerate(thresholds):
            with self.subTest(minimum=minimum):
                self.assertEqual(rank_for_elo(minimum), label)
                if minimum:
                    self.assertEqual(rank_for_elo(minimum - 1), thresholds[index - 1][1])
        self.assertEqual(rank_for_elo(100000), "Masters")
        with self.assertRaises(ValueError):
            rank_for_elo(-1)

    def test_k_boundaries_use_count_before_result(self):
        for count, expected in [(0, 60), (9, 60), (10, 40), (29, 40), (30, 32), (59, 32), (60, 20), (1000, 20)]:
            self.assertEqual(k_for_matches(count), expected)
            update = calculate_elo_updates(
                [{"id": 1, "elo": 800, "matchesPlayed": count}],
                [{"id": 2, "elo": 800, "matchesPlayed": 0}], "Team A",
            )[0]
            self.assertEqual(update["kUsed"], expected)
            self.assertEqual(update["eloAfter"], 800 + expected // 2)
            self.assertEqual(update["matchesPlayedBefore"], count)
            self.assertEqual(update["matchesPlayedAfter"], count + 1)

    def test_mixed_experience_uses_individual_k_and_team_average(self):
        players = [{"id": index + 1, "elo": 800, "matchesPlayed": count} for index, count in enumerate([0, 10, 30, 60])]
        changes = calculate_elo_updates(players, [{"id": 5, "elo": 800, "matchesPlayed": 0}], "Team A")
        self.assertEqual([c["changeAmount"] for c in changes], [30, 20, 16, 10, -30])
        self.assertEqual([c["kUsed"] for c in changes], [60, 40, 32, 20, 60])

    def test_rank_movement_is_ordered_not_lexical(self):
        self.assertEqual(rank_movement("Silver 3", "Silver 2"), "promotion")
        self.assertEqual(rank_movement("Gold 2", "Gold 3"), "demotion")
        self.assertEqual(rank_movement("Diamond 1", "Masters"), "promotion")
        self.assertEqual(rank_movement("Gold 1", "Gold 1"), "unchanged")
        self.assertIsNone(rank_movement(None, "Gold 1"))

    def test_zero_floor_including_extreme_expected_scores(self):
        for opposing_rating in [0, 10000, 10**9]:
            updates = calculate_elo_updates(
                [{"id": 1, "elo": 0, "matchesPlayed": 0}],
                [{"id": 2, "elo": opposing_rating, "matchesPlayed": 60}], "Team B",
            )
            self.assertEqual(updates[0]["eloAfter"], 0)
            self.assertEqual(updates[0]["rankAfter"], "Iron 3")
            self.assertEqual(updates[0]["matchesPlayedAfter"], 1)
            self.assertTrue(all(c["eloAfter"] >= 0 for c in updates))
        updates = calculate_elo_updates(
            [{"id": 1, "elo": 10**9, "matchesPlayed": 0}],
            [{"id": 2, "elo": 0, "matchesPlayed": 0}], "Team B",
        )
        self.assertTrue(all(c["eloAfter"] >= 0 for c in updates))


class ProgressionIntegrationTests(unittest.TestCase):
    setUp = results.MatchResultTests.setUp
    tearDown = results.MatchResultTests.tearDown
    create_match = results.MatchResultTests.create_match
    complete = results.MatchResultTests.complete
    profile = results.MatchResultTests.profile

    def set_state(self, ids, elo, count):
        with sqlite3.connect(self.app.config["DATABASE_PATH"]) as connection:
            connection.executemany(
                "UPDATE players SET elo=?, matches_played=? WHERE id=?",
                [(elo, count, player_id) for player_id in ids],
            )

    def anonymous(self):
        return SignedClient(self.app, None, None)

    def test_new_player_and_server_owned_counter(self):
        player = self.client.post("/api/players", json={"name": "New", "positions": ["Setter"]}).get_json()
        self.assertEqual((player["elo"], player["rank"], player["matchesPlayed"], player["provisional"]), (800, "Bronze 3", 0, True))
        for extra in [{"matchesPlayed": 61}, {"rank": "Masters"}, {"provisional": False}]:
            self.assertEqual(self.client.post("/api/players", json={"name": "Invalid", "positions": ["Setter"], **extra}).status_code, 400)
            self.assertEqual(self.client.patch(f"/api/players/{player['id']}", json=extra).status_code, 400)
        updated = self.client.patch(f"/api/players/{player['id']}", json={"elo": 2300, "eloPublic": False}).get_json()
        self.assertEqual(updated["rank"], "Masters")
        self.assertEqual(updated["matchesPlayed"], 0)
        self.assertTrue(updated["provisional"])

    def test_placement_first_ten_matches_then_reverse_and_recomplete(self):
        self.set_state(self.player_ids, 800, 0)
        initial = self.profile(self.player_ids[0])
        for ordinal in range(1, 11):
            before = self.profile(self.player_ids[0])
            match = self.create_match()
            result = self.complete(match)
            entry = result["eloChanges"][0]
            self.assertEqual(entry["kUsed"], 60)
            self.assertEqual(entry["matchesPlayedBefore"], ordinal - 1)
            self.assertEqual(entry["matchesPlayedAfter"], ordinal)
            after = self.profile(self.player_ids[0])
            self.assertEqual(after["provisional"], ordinal < 10)
            self.assertEqual(after["matchesPlayed"], ordinal)
        self.assertFalse(after["provisional"])
        self.assertEqual(self.client.post(f"/api/matches/{match['id']}/reopen").status_code, 200)
        restored = self.profile(self.player_ids[0])
        for field in ["elo", "rank", "matchesPlayed", "provisional"]:
            self.assertEqual(restored[field], before[field])
        self.assertTrue(restored["provisional"])
        self.complete(match)
        eleventh = self.complete(self.create_match())
        self.assertTrue(all(e["kUsed"] == 40 for e in eleventh["eloChanges"]))
        self.assertEqual(self.profile(self.player_ids[0])["matchesPlayed"], 11)
        # Historical results retain the recorded count even as the profile advances.
        first = self.client.get("/api/matches/1").get_json()["eloChanges"][0]
        self.assertEqual(first["matchesPlayedAfter"], 1)
        self.assertEqual(initial["matchesPlayed"], 0)

    def test_promotions_demotions_exact_private_reversal_and_audit(self):
        self.set_state(self.player_ids[:6], 899, 9)
        self.set_state(self.player_ids[6:], 900, 10)
        target = self.player_ids[0]
        self.client.patch(f"/api/players/{target}", json={"eloPublic": False})
        before = {player_id: self.profile(player_id) for player_id in self.player_ids}
        match = self.create_match()
        completed = self.complete(match)
        winner, loser = completed["eloChanges"][0], completed["eloChanges"][6]
        self.assertEqual((winner["rankBefore"], winner["rankAfter"], winner["rankMovement"]), ("Bronze 3", "Bronze 2", "promotion"))
        self.assertEqual((loser["rankBefore"], loser["rankAfter"], loser["rankMovement"]), ("Bronze 2", "Bronze 3", "demotion"))
        self.assertEqual((winner["kUsed"], loser["kUsed"]), (60, 40))
        self.assertFalse(self.profile(target)["provisional"])
        self.assertEqual(self.profile(target)["matchesPlayed"], 10)
        self.assertEqual(self.profile(target)["rank"], "Bronze 2")
        self.assertNotIn(target, [p["id"] for p in self.anonymous().get("/api/leaderboard").get_json()])
        self.assertEqual(self.client.post(f"/api/matches/{match['id']}/reopen").status_code, 200)
        for player_id in self.player_ids:
            restored = self.profile(player_id)
            for field in ["elo", "rank", "matchesPlayed", "provisional", "eloPublic"]:
                self.assertEqual(restored[field], before[player_id][field])
        history = self.client.get(f"/api/players/{target}/elo-history").get_json()
        original, reverse = history
        self.assertEqual(reverse["kUsed"], original["kUsed"])
        self.assertEqual(reverse["matchesPlayedBefore"], original["matchesPlayedAfter"])
        self.assertEqual(reverse["matchesPlayedAfter"], original["matchesPlayedBefore"])
        self.assertEqual(reverse["rankBefore"], original["rankAfter"])
        self.assertEqual(reverse["rankAfter"], original["rankBefore"])
        self.assertEqual(reverse["rankMovement"], "demotion")
        self.complete(match)
        self.assertEqual(self.profile(target)["matchesPlayed"], 10)

    def test_threshold_reversals_never_recompute_k(self):
        for count, expected in [(9, 60), (10, 40), (29, 40), (30, 32), (59, 32), (60, 20)]:
            with self.subTest(count=count):
                self.set_state(self.player_ids, 800, count)
                before = self.profile(self.player_ids[0])
                match = self.create_match()
                result = self.complete(match)
                self.assertTrue(all(e["kUsed"] == expected for e in result["eloChanges"]))
                self.assertEqual(self.client.post(f"/api/matches/{match['id']}/reopen").status_code, 200)
                after = self.profile(self.player_ids[0])
                for field in ["elo", "rank", "matchesPlayed", "provisional"]:
                    self.assertEqual(after[field], before[field])
                history = self.client.get(f"/api/players/{self.player_ids[0]}/elo-history").get_json()
                self.assertEqual(history[-1]["kUsed"], expected)

    def test_duplicate_invalid_and_dependent_reversal_do_not_change_counters(self):
        first = self.create_match()
        self.assertEqual(self.client.post(f"/api/matches/{first['id']}/result", json={"scoreA": 1, "scoreB": 1}).status_code, 400)
        self.assertEqual(self.profile(self.player_ids[0])["matchesPlayed"], 0)
        self.complete(first)
        self.assertEqual(self.client.post(f"/api/matches/{first['id']}/result", json={"scoreA": 1, "scoreB": 3}).status_code, 409)
        self.assertEqual(self.profile(self.player_ids[0])["matchesPlayed"], 1)
        second = self.create_match()
        self.complete(second)
        before = self.profile(self.player_ids[0])
        self.assertEqual(self.client.post(f"/api/matches/{first['id']}/reopen").status_code, 409)
        self.assertEqual(self.profile(self.player_ids[0]), before)
        self.assertEqual(self.client.post(f"/api/matches/{second['id']}/reopen").status_code, 200)
        self.assertEqual(self.profile(self.player_ids[0])["matchesPlayed"], 1)
        self.assertEqual(self.client.post(f"/api/matches/{first['id']}/reopen").status_code, 200)
        self.assertEqual(self.profile(self.player_ids[0])["matchesPlayed"], 0)

    def test_public_provisional_masters_private_filter_and_top_ten(self):
        self.set_state(self.player_ids, 800, 0)
        self.set_state([self.player_ids[0]], 2300, 9)
        self.set_state([self.player_ids[1]], 2400, 61)
        self.set_state([self.player_ids[2]], 2500, 0)
        for target in self.player_ids[1:3]:
            self.client.patch(f"/api/players/{target}", json={"eloPublic": False})
        leaderboard = self.anonymous().get("/api/leaderboard").get_json()
        self.assertEqual(len(leaderboard), 10)
        self.assertEqual(leaderboard[0]["id"], self.player_ids[0])
        self.assertEqual(leaderboard[0]["rank"], "Masters")
        self.assertTrue(leaderboard[0]["provisional"])
        self.assertTrue(all(p["provisional"] for p in leaderboard))
        self.assertFalse({p["id"] for p in leaderboard} & set(self.player_ids[1:3]))
        # Restore one private high rank; cap still applies, without excluding placements.
        self.client.patch(f"/api/players/{self.player_ids[1]}", json={"eloPublic": True})
        updated = self.anonymous().get("/api/leaderboard").get_json()
        self.assertEqual(len(updated), 10)
        self.assertFalse(updated[0]["provisional"])
        self.assertEqual(updated[1]["id"], self.player_ids[0])

    def test_private_rank_redaction_owner_admin_other_snapshots_and_deleted_history(self):
        target = self.player_ids[0]
        self.client.patch(f"/api/players/{target}", json={"eloPublic": False})
        owner = SignedClient(self.app, "user_progression_owner", "progression-owner@example.test")
        owner.get("/api/auth/me")
        self.client.patch("/api/admin/accounts/user_progression_owner", json={"playerId": target})
        match = self.create_match()
        self.complete(match)
        for viewer in [self.anonymous(), SignedClient(self.app, "user_progression_other", "other@example.test")]:
            self.assertIsNone(viewer.get(f"/api/players/{target}").get_json()["rank"])
            response = viewer.get(f"/api/matches/{match['id']}").get_json()
            self.assertIsNone(response["teamA"][0]["rank"])
            audit = next(c for c in response["eloChanges"] if c["playerId"] == target)
            for field in ["eloBefore", "eloAfter", "changeAmount", "rankBefore", "rankAfter", "rankMovement"]:
                self.assertIsNone(audit[field])
        for viewer in [owner, self.client]:
            profile = viewer.get(f"/api/players/{target}").get_json()
            self.assertEqual(profile["rank"], "Bronze 1")
            self.assertEqual(profile["matchesPlayed"], 1)
            self.assertTrue(profile["provisional"])
            self.assertEqual(viewer.get(f"/api/matches/{match['id']}").get_json()["eloChanges"][0]["rankAfter"], "Bronze 1")
        self.client.delete(f"/api/players/{target}")
        for viewer, visible in [(owner, True), (self.client, True), (self.anonymous(), False)]:
            # The existing dedicated history route returns 404 for deleted
            # players; historical match audits remain available and protected.
            response = viewer.get(f"/api/matches/{match['id']}").get_json()
            audit = next(c for c in response["eloChanges"] if c["playerId"] == target)
            self.assertEqual(audit["rankAfter"], "Bronze 1" if visible else None)
            self.assertEqual(viewer.get(f"/api/players/{target}/elo-history").status_code, 404)
        self.assertEqual(self.client.post(f"/api/matches/{match['id']}/reopen").status_code, 200)
        with sqlite3.connect(self.app.config["DATABASE_PATH"]) as connection:
            counter = connection.execute(
                "SELECT matches_played_after FROM elo_history WHERE player_id=? ORDER BY id DESC LIMIT 1",
                (target,),
            ).fetchone()[0]
            self.assertEqual(counter, 0)

    def test_database_failure_rolls_back_rating_counter_audit_and_result(self):
        match = self.create_match()
        before = self.profile(self.player_ids[0])
        with sqlite3.connect(self.app.config["DATABASE_PATH"]) as connection:
            connection.execute(
                "CREATE TRIGGER reject_audit BEFORE INSERT ON elo_history "
                "BEGIN SELECT RAISE(ABORT, 'test audit failure'); END"
            )
        with self.assertLogs(self.app.logger, level="ERROR"):
            response = self.client.post(f"/api/matches/{match['id']}/result", json={"scoreA": 3, "scoreB": 1})
        self.assertEqual(response.status_code, 500)
        self.assertEqual(self.profile(self.player_ids[0]), before)
        self.assertEqual(self.client.get(f"/api/matches/{match['id']}").get_json()["status"], "upcoming")
        self.assertEqual(self.client.get(f"/api/players/{self.player_ids[0]}/elo-history").get_json(), [])

    def test_failed_reversal_rolls_back_rating_counter_priority_and_audit(self):
        match = self.create_match()
        completed = self.complete(match)
        target = self.player_ids[5]  # Filled role carries a priority event too.
        before = self.profile(target)
        history = self.client.get(f"/api/players/{target}/elo-history").get_json()
        with sqlite3.connect(self.app.config["DATABASE_PATH"]) as connection:
            connection.execute(
                "CREATE TRIGGER reject_reversal BEFORE INSERT ON elo_history "
                "WHEN NEW.action='reversal' "
                "BEGIN SELECT RAISE(ABORT, 'test reversal failure'); END"
            )
        with self.assertLogs(self.app.logger, level="ERROR"):
            response = self.client.post(f"/api/matches/{match['id']}/reopen")
        self.assertEqual(response.status_code, 500)
        self.assertEqual(self.profile(target), before)
        self.assertEqual(self.client.get(f"/api/matches/{match['id']}").get_json(), completed)
        self.assertEqual(self.client.get(f"/api/players/{target}/elo-history").get_json(), history)


class ProgressionMigrationTests(unittest.TestCase):
    def test_populated_legacy_audit_is_preserved_and_rating_only_reversal_is_supported(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "legacy.sqlite3"
            roster = [{"id": 1, "name": "Legacy", "positions": ["Setter"], "elo": 1000}]
            with sqlite3.connect(path) as connection:
                connection.executescript("""
                    CREATE TABLE players (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT,
                        positions_json TEXT, elo INTEGER DEFAULT 1000, created_at TEXT);
                    CREATE TABLE matches (id INTEGER PRIMARY KEY, team_a_json TEXT, team_b_json TEXT,
                        score_a INTEGER, score_b INTEGER, status TEXT, created_at TEXT);
                    CREATE TABLE elo_history (id INTEGER PRIMARY KEY, player_id INTEGER, match_id INTEGER,
                        elo_before INTEGER, elo_after INTEGER, change_amount INTEGER, action TEXT, created_at TEXT);
                """)
                connection.execute("INSERT INTO players (id,name,positions_json,elo,created_at) VALUES (1,'Legacy','[\"Setter\"]',1016,'2026-01-01')")
                connection.execute("INSERT INTO matches VALUES (1,?,'[]',3,1,'completed','2026-01-01')", (json.dumps(roster),))
                connection.execute("INSERT INTO elo_history VALUES (1,1,1,1000,1016,16,'result','2026-01-01')")
                roots_before = dict(connection.execute("SELECT name,rootpage FROM sqlite_master WHERE type='table' AND name IN ('players','matches','elo_history')"))
            initialize_database(str(path))
            initialize_database(str(path))
            client = SignedClient(create_app(path))
            history = client.get("/api/players/1/elo-history").get_json()[0]
            for field in ["kUsed", "rankBefore", "rankAfter", "rankMovement", "matchesPlayedBefore", "matchesPlayedAfter"]:
                self.assertIsNone(history[field])
            self.assertEqual((history["eloBefore"], history["eloAfter"], history["changeAmount"]), (1000, 1016, 16))
            self.assertEqual(client.get("/api/matches/1").get_json()["teamA"], roster)
            self.assertEqual(client.get("/api/players/1").get_json()["matchesPlayed"], 0)
            self.assertEqual(client.post("/api/matches/1/reopen").status_code, 200)
            self.assertEqual(client.get("/api/players/1").get_json()["elo"], 1000)
            self.assertEqual(client.get("/api/players/1").get_json()["matchesPlayed"], 0)
            reversal = client.get("/api/players/1/elo-history").get_json()[-1]
            self.assertIsNone(reversal["kUsed"])
            self.assertIsNone(reversal["matchesPlayedAfter"])
            created = client.post("/api/players", json={"name": "Fresh", "positions": ["Setter"]}).get_json()
            self.assertEqual((created["elo"], created["matchesPlayed"], created["rank"]), (800, 0, "Bronze 3"))
            with sqlite3.connect(path) as connection:
                roots_after = dict(connection.execute("SELECT name,rootpage FROM sqlite_master WHERE type='table' AND name IN ('players','matches','elo_history')"))
                self.assertEqual(roots_before, roots_after)
                for column in ["matches_played"]:
                    with self.assertRaises(sqlite3.IntegrityError):
                        connection.execute(f"UPDATE players SET {column}=-1 WHERE id=1")
                with self.assertRaises(sqlite3.IntegrityError):
                    connection.execute("UPDATE elo_history SET k_used=99 WHERE id=1")


if __name__ == "__main__":
    unittest.main()
