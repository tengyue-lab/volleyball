"""Development entry point for the Flask API."""

from pathlib import Path
import os
import sys
import subprocess

api_directory = Path(__file__).resolve().parent / "artifacts" / "api-server"
sys.path.insert(0, str(api_directory))

from app import app  # noqa: E402


if __name__ == "__main__":
    # One managed workflow: auth-only gateway supervising the original Flask
    # app on a private Unix socket. Domain routes are never moved to Express.
    subprocess.run(["pnpm", "--filter", "@workspace/api-server", "run", "build"], check=True)
    os.execvp("node", ["node", str(api_directory / "dist" / "auth-gateway.mjs")])
