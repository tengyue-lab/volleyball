import base64
import json
import sqlite3
import time
import unittest

import test_match_results as results
from auth_client import SignedClient
from privacy_auth import INITIAL_ADMIN_EMAILS, sign_request


class PrivacyTests(unittest.TestCase):
    setUp = results.MatchResultTests.setUp
    tearDown = results.MatchResultTests.tearDown
    create_match = results.MatchResultTests.create_match
    complete = results.MatchResultTests.complete
    profile = results.MatchResultTests.profile
    record_completed_roster = results.MatchResultTests.record_completed_roster

    def anonymous(self):
        return SignedClient(self.app, None, None)

    def owner(self, player_id):
        owner = SignedClient(self.app, "user_test_owner", "owner@example.test")
        owner.get("/api/auth/me")
        linked = self.client.patch("/api/admin/accounts/user_test_owner", json={"playerId": player_id})
        self.assertEqual(linked.status_code, 200)
        return owner

    def test_default_public_cap_and_filter_before_limit(self):
        self.assertTrue(all(p["eloPublic"] for p in self.client.get("/api/players").get_json()))
        for _ in range(10):
            self.record_completed_roster({
                player_id: results.ROLE_FORMATION[index % len(results.ROLE_FORMATION)]
                for index, player_id in enumerate(self.player_ids)
            })
        expected_ids = [p["id"] for p in sorted(
            self.client.get("/api/players").get_json(),
            key=lambda p: (-p["elo"], p["name"].casefold(), p["id"])
        )]
        before = self.anonymous().get("/api/leaderboard").get_json()
        self.assertEqual(len(before), 5)
        self.assertEqual([p["id"] for p in before], expected_ids[:5])
        hidden = self.player_ids[0]
        self.client.patch(f"/api/players/{hidden}", json={"eloPublic": False})
        after = self.anonymous().get("/api/leaderboard").get_json()
        self.assertEqual(len(after), 5)
        self.assertNotIn(hidden, [p["id"] for p in after])
        self.assertEqual([p["id"] for p in after], [player_id for player_id in expected_ids if player_id != hidden][:5])
        self.assertEqual(self.client.get("/api/leaderboard").get_json(), after)
        self.client.patch(f"/api/players/{hidden}", json={"eloPublic": True})
        self.assertEqual(self.anonymous().get("/api/leaderboard").get_json(), before)

    def test_fewer_and_no_public_players(self):
        for _ in range(10):
            self.record_completed_roster({
                player_id: results.ROLE_FORMATION[index % len(results.ROLE_FORMATION)]
                for index, player_id in enumerate(self.player_ids)
            })
        for player_id in self.player_ids[2:]:
            self.client.patch(f"/api/players/{player_id}", json={"eloPublic": False})
        self.assertEqual(len(self.anonymous().get("/api/leaderboard").get_json()), 2)
        for player_id in self.player_ids[:2]:
            self.client.patch(f"/api/players/{player_id}", json={"eloPublic": False})
        self.assertEqual(self.anonymous().get("/api/leaderboard").get_json(), [])

    def test_strict_boolean_creation_updates_and_preservation(self):
        target = self.player_ids[0]
        for bad in (0, 1, "false", None, [], {}):
            self.assertEqual(self.client.patch(f"/api/players/{target}", json={"eloPublic": bad}).status_code, 400)
            self.assertEqual(self.client.post("/api/players", json={"name": "Invalid", "positions": ["Setter"], "eloPublic": bad}).status_code, 400)
        created = self.client.post("/api/players", json={"name": "Private", "positions": ["Libero", "Setter"], "eloPublic": False}).get_json()
        self.assertFalse(created["eloPublic"])
        changed = self.client.patch(f"/api/players/{created['id']}", json={"name": "Still private"}).get_json()
        self.assertFalse(changed["eloPublic"])
        self.assertEqual(changed["positions"], ["Libero", "Setter"])
        self.assertEqual(changed["elo"], 800)

    def test_private_profile_owner_admin_other_and_anonymous(self):
        target = self.player_ids[0]
        owner = self.owner(target)
        response = owner.patch(f"/api/players/{target}", json={"eloPublic": False})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["elo"], 1050)
        other = SignedClient(self.app, "user_test_other", "other@example.test")
        for client in (self.anonymous(), other):
            self.assertIsNone(client.get(f"/api/players/{target}").get_json()["elo"])
            self.assertIsNone(next(p for p in client.get("/api/players").get_json() if p["id"] == target)["elo"])
        self.assertEqual(self.profile(target)["elo"], 1050)
        self.assertEqual(owner.get("/api/auth/me").get_json()["playerId"], target)
        self.assertFalse(owner.get("/api/auth/me").get_json()["isAdmin"])

    def test_public_opt_in_never_exposes_exact_elo_to_other_viewers(self):
        target = self.player_ids[0]
        owner = self.owner(target)
        other = SignedClient(self.app, "user_test_public_other", "public-other@example.test")
        admin_elo = self.client.get(f"/api/players/{target}").get_json()["elo"]
        self.assertIsNotNone(admin_elo)
        for viewer in (self.anonymous(), other):
            detail = viewer.get(f"/api/players/{target}").get_json()
            listed = next(
                player for player in viewer.get("/api/players").get_json()
                if player["id"] == target
            )
            for profile in (detail, listed):
                self.assertTrue(profile["eloPublic"])
                self.assertIsNone(profile["elo"])
                self.assertIsNone(profile["rank"])
        self.assertEqual(owner.get(f"/api/players/{target}").get_json()["elo"], admin_elo)
        self.assertEqual(self.client.get(f"/api/players/{target}").get_json()["elo"], admin_elo)

    def test_public_rank_tier_ranges_reflect_configured_thresholds(self):
        response = self.anonymous().get("/api/rank-tiers")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), [
            {"tier": "Iron", "minElo": 0, "maxElo": 799},
            {"tier": "Bronze", "minElo": 800, "maxElo": 1099},
            {"tier": "Silver", "minElo": 1100, "maxElo": 1399},
            {"tier": "Gold", "minElo": 1400, "maxElo": 1699},
            {"tier": "Platinum", "minElo": 1700, "maxElo": 1999},
            {"tier": "Diamond", "minElo": 2000, "maxElo": 2299},
            {"tier": "Masters", "minElo": 2300, "maxElo": None},
        ])

    def test_nonadmin_mutations_and_ownership_are_denied(self):
        target = self.player_ids[0]
        owner = self.owner(target)
        self.assertEqual(owner.patch(f"/api/players/{target}", json={"elo": 9999}).status_code, 403)
        self.assertEqual(owner.patch(f"/api/players/{target}", json={"eloPublic": False, "isAdmin": True}).status_code, 403)
        self.assertEqual(owner.patch(f"/api/players/{self.player_ids[1]}", json={"eloPublic": False}).status_code, 403)
        self.assertEqual(owner.delete(f"/api/players/{target}").status_code, 403)
        self.assertEqual(owner.post("/api/players", json={"name": "No", "positions": ["Setter"]}).status_code, 403)
        for route in ("/api/admin/accounts", "/api/admin/admin-access"):
            self.assertEqual(owner.get(route).status_code, 403)
            self.assertEqual(self.anonymous().get(route).status_code, 401)
        self.assertEqual(owner.patch("/api/admin/accounts/user_test_owner", json={"playerId": self.player_ids[1]}).status_code, 403)
        self.assertEqual(owner.post("/api/matches", json={}).status_code, 403)
        self.assertEqual(owner.post("/api/matches/1/result", json={"scoreA": 3, "scoreB": 1}).status_code, 403)
        self.assertEqual(owner.post("/api/matches/1/reopen").status_code, 403)
        self.assertEqual(self.anonymous().post("/api/players", json={}).status_code, 401)

    def test_private_snapshots_history_and_deleted_owner_stay_private(self):
        target = self.player_ids[0]
        owner = self.owner(target)
        match = self.create_match()
        self.complete(match)
        with sqlite3.connect(self.app.config["DATABASE_PATH"]) as conn:
            stored_before = conn.execute("SELECT team_a_json FROM matches WHERE id=?", (match["id"],)).fetchone()[0]
        owner.patch(f"/api/players/{target}", json={"eloPublic": False})
        anon = self.anonymous()
        for response in (anon.get(f"/api/matches/{match['id']}").get_json(), anon.get("/api/matches").get_json()[0]):
            self.assertIsNone(response["teamA"][0]["elo"])
        self.assertEqual(anon.get(f"/api/players/{target}/elo-history").status_code, 401)
        changes = anon.get(f"/api/matches/{match['id']}").get_json()["eloChanges"]
        self.assertEqual(changes, [])
        self.assertIsNone(owner.get(f"/api/matches/{match['id']}").get_json()["teamA"][0]["elo"])
        self.assertEqual(self.client.delete(f"/api/players/{target}").status_code, 204)
        self.assertIsNone(anon.get(f"/api/matches/{match['id']}").get_json()["teamA"][0]["elo"])
        self.assertIsNone(owner.get(f"/api/matches/{match['id']}").get_json()["teamA"][0]["elo"])
        self.assertEqual(self.client.get(f"/api/matches/{match['id']}").get_json()["teamA"][0]["elo"], 1050)
        with sqlite3.connect(self.app.config["DATABASE_PATH"]) as conn:
            self.assertEqual(conn.execute("SELECT team_a_json FROM matches WHERE id=?", (match["id"],)).fetchone()[0], stored_before)

    def test_private_players_still_receive_real_result_priority_and_reversal(self):
        target = self.player_ids[5]
        self.client.patch(f"/api/players/{target}", json={"eloPublic": False})
        match = self.create_match()
        self.assertEqual(match["teamA"][5]["elo"], 1050)
        self.complete(match)
        self.assertEqual(self.profile(target)["elo"], 1076)
        self.assertTrue(self.profile(target)["preferredRolePriority"])
        self.assertIsNone(self.anonymous().get(f"/api/players/{target}").get_json()["elo"])
        self.assertEqual(self.client.post(f"/api/matches/{match['id']}/reopen").status_code, 200)
        self.assertEqual(self.profile(target)["elo"], 1050)
        self.assertFalse(self.profile(target)["preferredRolePriority"])
        self.assertFalse(self.profile(target)["eloPublic"])

    def test_leaderboard_minimal_contract_for_anonymous_owner_other_and_admin(self):
        for _ in range(10):
            self.record_completed_roster({
                player_id: results.ROLE_FORMATION[index % len(results.ROLE_FORMATION)]
                for index, player_id in enumerate(self.player_ids)
            })
        owner = self.owner(self.player_ids[0])
        other = SignedClient(self.app, "user_test_social", "social@example.test")
        for viewer in (self.anonymous(), owner, other, self.client):
            response = viewer.get("/api/leaderboard")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(len(response.get_json()), 5)
            self.assertEqual(
                [row["placement"] for row in response.get_json()], [1, 2, 3, 4, 5]
            )
            for row in response.get_json():
                self.assertEqual(
                    set(row),
                    {"id", "placement", "name", "mostPlayedPosition", "tier"},
                )
                self.assertTrue(row["tier"])
                self.assertNotIn("elo", row)

    def test_public_top_five_uses_completed_history_tiers_and_assigned_roles(self):
        counts = {player_id: 10 for player_id in self.player_ids}
        provisional_id = self.player_ids[0]
        counts[provisional_id] = 9
        role_sequences = {
            self.player_ids[1]: ["Outside Hitter"] * 6 + ["Setter"] * 4,
            self.player_ids[3]: ["Outside Hitter"] * 5 + ["Setter"] * 5,
            self.player_ids[5]: ["Setter"] * 9 + [None],
        }
        for appearance in range(10):
            assignments = {}
            for index, player_id in enumerate(self.player_ids):
                if appearance >= counts[player_id]:
                    continue
                sequence = role_sequences.get(player_id)
                assignments[player_id] = (
                    sequence[appearance] if sequence is not None
                    else results.ROLE_FORMATION[index % len(results.ROLE_FORMATION)]
                )
            self.record_completed_roster(assignments)

        ratings = {
            self.player_ids[0]: 3000,  # Highest rating, but only nine completed matches.
            self.player_ids[1]: 2300,  # Masters
            self.player_ids[2]: 2500,  # Higher than the public leaders, but private.
            self.player_ids[3]: 2000,  # Diamond
            self.player_ids[4]: 1700,  # Platinum
            self.player_ids[5]: 1400,  # Gold; one incomplete role history.
            self.player_ids[6]: 1100,  # Silver
        }
        with sqlite3.connect(self.app.config["DATABASE_PATH"]) as connection:
            for player_id, elo in ratings.items():
                connection.execute(
                    "UPDATE players SET elo = ? WHERE id = ?", (elo, player_id)
                )
        private_id = self.player_ids[2]
        self.client.patch(f"/api/players/{private_id}", json={"eloPublic": False})

        provisional_profile = self.client.get(
            f"/api/players/{provisional_id}"
        ).get_json()
        established_profile = self.client.get(
            f"/api/players/{self.player_ids[1]}"
        ).get_json()
        self.assertEqual(
            (provisional_profile["matchesPlayed"], provisional_profile["provisional"]),
            (9, True),
        )
        self.assertEqual(
            (established_profile["matchesPlayed"], established_profile["provisional"]),
            (10, False),
        )

        leaderboard = self.anonymous().get("/api/leaderboard").get_json()
        expected_ids = [
            self.player_ids[1],
            self.player_ids[3],
            self.player_ids[4],
            self.player_ids[5],
            self.player_ids[6],
        ]
        self.assertEqual([entry["id"] for entry in leaderboard], expected_ids)
        self.assertEqual([entry["placement"] for entry in leaderboard], [1, 2, 3, 4, 5])
        self.assertEqual(
            [entry["tier"] for entry in leaderboard],
            ["Masters", "Diamond", "Platinum", "Gold", "Silver"],
        )
        self.assertEqual(leaderboard[0]["mostPlayedPosition"], "Outside Hitter")
        self.assertEqual(leaderboard[1]["mostPlayedPosition"], "Setter")
        self.assertIsNone(leaderboard[3]["mostPlayedPosition"])
        self.assertNotIn(provisional_id, [entry["id"] for entry in leaderboard])
        self.assertNotIn(private_id, [entry["id"] for entry in leaderboard])
        self.assertTrue(all(
            set(entry) == {
                "id", "placement", "name", "mostPlayedPosition", "tier"
            }
            for entry in leaderboard
        ))

    def test_match_rating_information_admin_only_even_for_public_players_and_owner(self):
        target = self.player_ids[0]
        owner = self.owner(target)
        other = SignedClient(self.app, "user_test_history", "history@example.test")
        match = self.create_match()
        self.complete(match)
        admin = self.client.get(f"/api/matches/{match['id']}").get_json()
        self.assertTrue(admin["eloChanges"])
        self.assertIsInstance(admin["teamA"][0]["elo"], int)
        admin_history = self.client.get(f"/api/players/{target}/elo-history")
        self.assertEqual(admin_history.status_code, 200)
        self.assertIsInstance(admin_history.get_json()[0]["eloBefore"], int)
        # Cover GET and HEAD, list/detail, query strings and both visibility states.
        for public in (True, False):
            self.client.patch(f"/api/players/{target}", json={"eloPublic": public})
            for viewer in (self.anonymous(), owner, other):
                for path in ("/api/matches", f"/api/matches/{match['id']}?details=1"):
                    response = viewer.get(path)
                    self.assertEqual(response.status_code, 200)
                    data = response.get_json()
                    data = data[0] if isinstance(data, list) else data
                    self.assertEqual(data["eloChanges"], [])
                    for field in ("scoreA", "scoreB", "winner", "status", "matchDate", "completedAt", "createdAt"):
                        self.assertEqual(data[field], admin[field])
                    for team in ("teamA", "teamB"):
                        for player, full in zip(data[team], admin[team]):
                            self.assertIsNone(player["elo"])
                            self.assertIsNone(player["rank"])
                            for field in ("id", "name", "positions", "assignedPosition", "assignmentStatus", "preferenceRank"):
                                self.assertEqual(player.get(field), full.get(field))
                            for field in ("matchesPlayed", "provisional", "eloPublic", "eloBefore", "eloAfter", "changeAmount", "kUsed"):
                                self.assertNotIn(field, player)
                expected = 401 if viewer.identity["userId"] is None else 403
                audit_path = f"/api/players/{target}/elo-history"
                self.assertEqual(viewer.get(audit_path).status_code, expected)
                self.assertEqual(viewer.open(audit_path, method="HEAD").status_code, expected)
            profile = owner.get(f"/api/players/{target}").get_json()
            self.assertEqual(profile["elo"], self.profile(target)["elo"])
            self.assertEqual(profile["rank"], self.profile(target)["rank"])
            self.assertEqual(profile["eloPublic"], public)

    def test_unidentifiable_legacy_snapshot_ratings_fail_closed(self):
        match = self.create_match()
        with sqlite3.connect(self.app.config["DATABASE_PATH"]) as conn:
            team = json.loads(conn.execute(
                "SELECT team_a_json FROM matches WHERE id=?", (match["id"],)
            ).fetchone()[0])
            team[0].pop("id")
            team[1]["id"] = 999999
            conn.execute("UPDATE matches SET team_a_json=? WHERE id=?", (json.dumps(team), match["id"]))
        public = self.anonymous().get(f"/api/matches/{match['id']}").get_json()
        self.assertIsNone(public["teamA"][0]["elo"])
        self.assertIsNone(public["teamA"][1]["elo"])
        admin = self.client.get(f"/api/matches/{match['id']}").get_json()
        self.assertEqual(admin["teamA"][0]["elo"], 1050)

    def test_link_validation_uniqueness_and_unlink(self):
        target = self.player_ids[0]
        first = self.owner(target)
        second = SignedClient(self.app, "user_test_second", "second@example.test")
        second.get("/api/auth/me")
        self.assertEqual(self.client.patch("/api/admin/accounts/user_test_second", json={"playerId": target}).status_code, 409)
        self.assertEqual(self.client.patch("/api/admin/accounts/user_missing", json={"playerId": target}).status_code, 404)
        for bad in (True, 0, "1", -1):
            self.assertEqual(self.client.patch("/api/admin/accounts/user_test_second", json={"playerId": bad}).status_code, 400)
        self.assertEqual(self.client.patch("/api/admin/accounts/user_test_owner", json={"playerId": None}).status_code, 200)
        self.assertIsNone(first.get("/api/auth/me").get_json()["playerId"])
        self.assertEqual(self.client.patch("/api/admin/accounts/user_test_second", json={"playerId": target}).status_code, 200)

    def test_verified_email_admin_grants_future_signin_and_revocation(self):
        unverified = SignedClient(self.app, "user_test_unverified", None)
        self.assertFalse(unverified.get("/api/auth/me").get_json()["isAdmin"])
        self.assertTrue(self.client.get("/api/auth/me").get_json()["isAdmin"])
        self.assertEqual(self.client.post("/api/admin/admin-access", json={"email": "FUTURE@example.test"}).status_code, 201)
        future = SignedClient(self.app, "user_test_future", "future@example.test")
        self.assertTrue(future.get("/api/auth/me").get_json()["isAdmin"])
        self.assertEqual(self.client.delete("/api/admin/admin-access/future@example.test").status_code, 204)
        self.assertFalse(future.get("/api/auth/me").get_json()["isAdmin"])
        self.assertEqual(future.get("/api/admin/accounts").status_code, 403)
        self.assertEqual(self.client.delete(f"/api/admin/admin-access/{INITIAL_ADMIN_EMAILS[0]}").status_code, 409)
        self.assertFalse(SignedClient(self.app, "user_test_first", "first@example.test").get("/api/auth/me").get_json()["isAdmin"])

    def test_no_store_and_identity_does_not_persist_between_requests(self):
        target = self.player_ids[0]
        self.client.patch(f"/api/players/{target}", json={"eloPublic": False})
        response = self.client.get(f"/api/players/{target}")
        self.assertEqual(response.headers["Cache-Control"], "private, no-store")
        self.assertEqual(response.headers["Vary"], "Cookie")
        self.assertIsNotNone(response.get_json()["elo"])
        self.assertIsNone(self.anonymous().get(f"/api/players/{target}").get_json()["elo"])

    def test_unsigned_forged_expired_and_tampered_requests_fail_closed(self):
        raw = self.app.test_client()
        for headers in ({}, {"X-User-Id": "user_test_admin", "X-Is-Admin": "true"},
                        {"X-Sideout-Identity": '{"userId":"user_test_admin","email":"'+INITIAL_ADMIN_EMAILS[0]+'"}'}):
            self.assertEqual(raw.get("/api/players", headers=headers).status_code, 403)
        uri = "/api/players"
        context = base64.b64encode(json.dumps({"userId": "user_test_admin", "email": INITIAL_ADMIN_EMAILS[0]}).encode()).decode()
        timestamp = str(time.time() - 60)
        signature = sign_request(self.app.config["AUTH_GATEWAY_SECRET"], "GET", uri, timestamp, context, b"")
        headers = {"X-Sideout-Time": timestamp, "X-Sideout-Identity": context, "X-Sideout-Signature": signature}
        self.assertEqual(raw.get(uri, headers=headers).status_code, 403)
        timestamp = str(time.time())
        headers["X-Sideout-Time"] = timestamp
        headers["X-Sideout-Signature"] = sign_request(self.app.config["AUTH_GATEWAY_SECRET"], "GET", uri, timestamp, context, b"")
        self.assertEqual(raw.get("/api/admin/accounts", headers=headers).status_code, 403)
        self.assertEqual(raw.patch(uri+"/1", headers=headers, json={"elo": 9999}).status_code, 403)

    def test_malformed_identity_and_query_binding_fail_closed(self):
        raw = self.app.test_client()
        for identity in ({"userId": "user_test_owner", "email": "owner@example.test", "isAdmin": True}, {"userId": None, "email": INITIAL_ADMIN_EMAILS[0]}, []):
            timestamp = str(time.time())
            context = base64.b64encode(json.dumps(identity).encode()).decode()
            headers = {"X-Sideout-Time": timestamp, "X-Sideout-Identity": context,
                       "X-Sideout-Signature": sign_request(self.app.config["AUTH_GATEWAY_SECRET"], "GET", "/api/players", timestamp, context, b"")}
            self.assertEqual(raw.get("/api/players", headers=headers).status_code, 403)
        self.assertEqual(self.anonymous().get("/api/players?test=1").status_code, 200)


if __name__ == "__main__":
    unittest.main()
