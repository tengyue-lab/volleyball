"""Signed gateway fixture; no production testing bypass or fake auth route."""
import base64
import json
import time

from privacy_auth import INITIAL_ADMIN_EMAILS, sign_request


class SignedClient:
    def __init__(self, app, user_id="user_test_admin", email=INITIAL_ADMIN_EMAILS[0]):
        self.app = app
        self.client = app.test_client()
        app.config["AUTH_GATEWAY_SECRET"] = "isolated-unit-test-transport-key"
        self.identity = {"userId": user_id, "email": email}

    def open(self, path, method="GET", **kwargs):
        if "json" in kwargs:
            kwargs["data"] = self.app.json.dumps(kwargs.pop("json"))
            kwargs["content_type"] = "application/json"
        data = kwargs.get("data", "")
        body = data.encode() if isinstance(data, str) else data
        timestamp = str(time.time())
        identity = base64.b64encode(json.dumps(self.identity).encode()).decode()
        headers = dict(kwargs.pop("headers", {}))
        headers.update({
            "X-Sideout-Time": timestamp, "X-Sideout-Identity": identity,
            "X-Sideout-Signature": sign_request(
                self.app.config["AUTH_GATEWAY_SECRET"], method, path, timestamp, identity, body
            ),
        })
        return self.client.open(path, method=method, headers=headers, **kwargs)

    def get(self, path, **kwargs):
        return self.open(path, "GET", **kwargs)

    def post(self, path, **kwargs):
        return self.open(path, "POST", **kwargs)

    def patch(self, path, **kwargs):
        return self.open(path, "PATCH", **kwargs)

    def delete(self, path, **kwargs):
        return self.open(path, "DELETE", **kwargs)
