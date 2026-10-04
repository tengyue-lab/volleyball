"""Development entry point for the Flask API."""

from pathlib import Path
import os
import sys

api_directory = Path(__file__).resolve().parent / "artifacts" / "api-server"
sys.path.insert(0, str(api_directory))

from app import app  # noqa: E402


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
