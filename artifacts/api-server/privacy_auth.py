"""Access gates and read-time privacy; Flask remains the domain backend.

The Clerk gateway signs identity, method, raw URI and body for each request.
No browser-provided identity headers or role flags are trusted here.
"""

import base64
import hashlib
import hmac
import json
import os
import re
import sqlite3
import time

from flask import g, jsonify, request

INITIAL_ADMIN_EMAILS = ("tengyue@wyndhamwombats.com",)


def initialize_auth_schema(connection):
    columns = {row[1] for row in connection.execute("PRAGMA table_info(players)")}
    if "elo_public" not in columns:
        connection.execute(
            "ALTER TABLE players ADD COLUMN elo_public INTEGER NOT NULL DEFAULT 1 "
            "CHECK (elo_public IN (0, 1))"
        )
    connection.executescript("""
        CREATE TABLE IF NOT EXISTS app_accounts (
            id TEXT PRIMARY KEY, email TEXT, player_id INTEGER UNIQUE
        );
        CREATE TABLE IF NOT EXISTS admin_emails (
            email TEXT PRIMARY KEY
        );
        CREATE TABLE IF NOT EXISTS archived_player_owners (
            player_id INTEGER PRIMARY KEY, account_id TEXT NOT NULL
        );
    """)
    for email in INITIAL_ADMIN_EMAILS:
        connection.execute("INSERT OR IGNORE INTO admin_emails VALUES (?)", (email,))


def sign_request(secret, method, uri, timestamp, context, body):
    message = "\n".join(
        [method, uri, timestamp, context, hashlib.sha256(body).hexdigest()]
    )
    return hmac.new(secret.encode(), message.encode(), hashlib.sha256).hexdigest()


def verified_identity():
    # The test suite uses the exact same signed transport with an isolated key.
    from flask import current_app
    secret = current_app.config.get("AUTH_GATEWAY_SECRET") or os.environ.get("AUTH_GATEWAY_SECRET")
    if not secret:
        raise ValueError("Authentication gateway is unavailable.")
    timestamp = request.headers.get("X-Sideout-Time", "")
    context = request.headers.get("X-Sideout-Identity", "")
    signature = request.headers.get("X-Sideout-Signature", "")
    if abs(time.time() - float(timestamp)) > 30:
        raise ValueError("Expired gateway request.")
    uri = request.environ.get("RAW_URI") or request.full_path.removesuffix("?")
    expected = sign_request(
        secret, request.method, uri, timestamp, context, request.get_data()
    )
    if not hmac.compare_digest(expected, signature):
        raise ValueError("Invalid gateway signature.")
    identity = json.loads(base64.b64decode(context, validate=True))
    if not isinstance(identity, dict) or set(identity) != {"userId", "email"}:
        raise ValueError("Invalid identity.")
    user_id, email = identity["userId"], identity["email"]
    if user_id is not None and (not isinstance(user_id, str) or not user_id.startswith("user_")):
        raise ValueError("Invalid account.")
    if email is not None and (not user_id or not isinstance(email, str)):
        raise ValueError("Invalid verified email.")
    return user_id, email.casefold() if email else None


def install_privacy(app, database):
    app.config["MAX_CONTENT_LENGTH"] = 1024 * 1024

    def account_json(row, connection):
        return {
            "id": row["id"], "email": row["email"], "playerId": row["player_id"],
            "isAdmin": bool(row["email"] and connection.execute(
                "SELECT 1 FROM admin_emails WHERE email=?", (row["email"],)
            ).fetchone()),
        }

    @app.before_request
    def access_gate():
        g.viewer = {"signedIn": False, "isAdmin": False, "userId": None, "email": None, "playerId": None}
        if request.path == "/api/healthz":
            return None
        try:
            user_id, email = verified_identity()
        except (ValueError, TypeError, OverflowError, json.JSONDecodeError):
            return jsonify({"error": "A verified authentication gateway is required."}), 403
        if user_id:
            with database() as connection:
                connection.execute(
                    "INSERT INTO app_accounts (id,email) VALUES (?,?) "
                    "ON CONFLICT(id) DO UPDATE SET email=excluded.email",
                    (user_id, email),
                )
                row = connection.execute("SELECT * FROM app_accounts WHERE id=?", (user_id,)).fetchone()
                account = account_json(row, connection)
            g.viewer = {
                "signedIn": True, "isAdmin": account["isAdmin"],
                "userId": user_id, "email": email, "playerId": account["playerId"],
            }
        if (
            request.path.startswith("/api/admin/")
            or request.endpoint == "get_player_elo_history"
        ) and not g.viewer["isAdmin"]:
            return jsonify({"error": "Administrator access required."}), 403 if user_id else 401
        if request.method not in ("GET", "HEAD", "OPTIONS"):
            if request.endpoint == "update_own_preferences":
                if not user_id:
                    return jsonify({"error": "Sign in to make changes."}), 401
                if g.viewer.get("playerId") is None:
                    return jsonify({"error": "Link your account to a player profile first."}), 403
                return None
            if g.viewer["isAdmin"]:
                return None
            if not user_id:
                return jsonify({"error": "Sign in to make changes."}), 401
            # Owners may only toggle visibility or edit ranked preferences on
            # their own linked player record. They cannot set ELO, identity,
            # ownership, role flags, or domain results.
            owns_profile = (
                request.endpoint == "update_player"
                and request.view_args.get("player_id") == g.viewer["playerId"]
            )
            body = request.get_json(silent=True)
            if not owns_profile or not isinstance(body, dict) or set(body) not in ({"eloPublic"}, {"positions"}):
                return jsonify({"error": "Administrator access required for this change."}), 403
        return None

    @app.after_request
    def privacy_projection(response):
        response.headers["Cache-Control"] = "private, no-store"
        response.headers["Vary"] = "Cookie"
        response.headers["X-Content-Type-Options"] = "nosniff"
        if not response.is_json or response.status_code >= 400:
            return response
        viewer = getattr(g, "viewer", {})
        if viewer.get("isAdmin"):
            return response
        if request.path == "/api/matches" or request.path.startswith("/api/matches/"):
            # Match privacy is independent of public rating flags and ownership.
            # Keep played roles/non-rating metadata; never modify stored snapshots.
            snapshot_fields = {
                "id", "name", "positions", "createdAt", "preferencesConfirmed",
                "preferredRolePriority", "prioritySince", "assignedPosition",
                "assignmentStatus", "preferenceRank",
            }

            def public_match(match):
                result = dict(match)
                for team in ("teamA", "teamB"):
                    result[team] = [
                        {**{key: value for key, value in player.items()
                            if key in snapshot_fields}, "elo": None, "rank": None}
                        for player in match.get(team, [])
                    ]
                result["eloChanges"] = []
                return result

            payload = response.get_json()
            payload = ([public_match(match) for match in payload]
                       if isinstance(payload, list) else public_match(payload))
            response.set_data(app.json.dumps(payload))
            return response
        with database() as connection:
            own_ids = {viewer["playerId"]} if viewer.get("playerId") is not None else set()
            if viewer.get("userId"):
                own_ids.update(row[0] for row in connection.execute(
                    "SELECT player_id FROM archived_player_owners WHERE account_id=?",
                    (viewer["userId"],),
                ))

        def project(value):
            if isinstance(value, list):
                return [project(item) for item in value]
            if not isinstance(value, dict):
                return value
            result = {key: project(item) for key, item in value.items()}
            if "positions" in result and "elo" in result and result.get("id") not in own_ids:
                for key in ("elo", "rank"):
                    if key in result:
                        result[key] = None
            if "eloBefore" in result and result.get("playerId") not in own_ids:
                for key in ("eloBefore", "eloAfter", "changeAmount", "rankBefore", "rankAfter", "rankMovement"):
                    if key in result:
                        result[key] = None
            return result

        response.set_data(app.json.dumps(project(response.get_json())))
        return response

    @app.get("/api/auth/me")
    def auth_viewer():
        return jsonify(g.viewer)

    @app.get("/api/admin/accounts")
    def admin_accounts():
        with database() as connection:
            rows = connection.execute("SELECT * FROM app_accounts ORDER BY email,id").fetchall()
            return jsonify([account_json(row, connection) for row in rows])

    @app.patch("/api/admin/accounts/<account_id>")
    def link_account(account_id):
        body = request.get_json(silent=True)
        if not isinstance(body, dict) or set(body) != {"playerId"}:
            return jsonify({"error": "Provide only playerId."}), 400
        player_id = body["playerId"]
        if player_id is not None and (type(player_id) is not int or player_id < 1):
            return jsonify({"error": "playerId must be a positive integer or null."}), 400
        with database() as connection:
            connection.execute("BEGIN IMMEDIATE")
            account = connection.execute("SELECT * FROM app_accounts WHERE id=?", (account_id,)).fetchone()
            if not account:
                return jsonify({"error": "Account must sign in before it can be linked."}), 404
            if player_id is not None:
                if not account["email"]:
                    return jsonify({"error": "Verify the account's primary email before linking."}), 400
                if not connection.execute("SELECT 1 FROM players WHERE id=?", (player_id,)).fetchone():
                    return jsonify({"error": "Player not found."}), 404
                conflict = connection.execute(
                    "SELECT 1 FROM app_accounts WHERE player_id=? AND id!=?", (player_id, account_id)
                ).fetchone()
                if conflict:
                    return jsonify({"error": "That player already belongs to another account. Unlink it first."}), 409
            connection.execute("UPDATE app_accounts SET player_id=? WHERE id=?", (player_id, account_id))
            row = connection.execute("SELECT * FROM app_accounts WHERE id=?", (account_id,)).fetchone()
            return jsonify(account_json(row, connection))

    @app.get("/api/admin/admin-access")
    def list_admin_access():
        with database() as connection:
            return jsonify([
                {"email": row[0], "bootstrap": row[0] in INITIAL_ADMIN_EMAILS}
                for row in connection.execute("SELECT email FROM admin_emails ORDER BY email")
            ])

    @app.post("/api/admin/admin-access")
    def grant_admin_access():
        body = request.get_json(silent=True)
        email = body.get("email") if isinstance(body, dict) and set(body) == {"email"} else None
        if not isinstance(email, str) or len(email.strip()) > 254 or not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email.strip()):
            return jsonify({"error": "Enter a valid administrator email address."}), 400
        email = email.strip().casefold()
        with database() as connection:
            connection.execute("INSERT OR IGNORE INTO admin_emails VALUES (?)", (email,))
        return jsonify({"email": email, "bootstrap": email in INITIAL_ADMIN_EMAILS}), 201

    @app.delete("/api/admin/admin-access/<path:email>")
    def revoke_admin_access(email):
        email = email.casefold()
        if email in INITIAL_ADMIN_EMAILS:
            return jsonify({"error": "The initial administrator cannot be removed."}), 409
        with database() as connection:
            cursor = connection.execute("DELETE FROM admin_emails WHERE email=?", (email,))
            if not cursor.rowcount:
                return jsonify({"error": "Administrator grant not found."}), 404
        return "", 204
