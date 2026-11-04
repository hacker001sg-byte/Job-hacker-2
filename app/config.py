"""All runtime settings come from environment variables (see .env.example)."""
import hashlib
import os
from pathlib import Path

DATA_DIR = Path(os.environ.get("DATA_DIR", "./data")).resolve()
DATA_DIR.mkdir(parents=True, exist_ok=True)

DATABASE_URL = os.environ.get("DATABASE_URL", f"sqlite:///{DATA_DIR / 'jobhacker.db'}")

# Login. If APP_PASSWORD is empty the app runs without a login screen
# (fine on a trusted LAN, NOT fine behind Tailscale Funnel / Cloudflare).
APP_PASSWORD = os.environ.get("APP_PASSWORD", "")
SECRET_KEY = os.environ.get("SECRET_KEY") or hashlib.sha256(
    ("job-hacker-2:" + APP_PASSWORD).encode()
).hexdigest()
SESSION_DAYS = int(os.environ.get("SESSION_DAYS", "90"))
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "auto")  # "auto" | "true" | "false"

# For automations (n8n, iOS Shortcuts): send header  X-API-Key: <token>
API_TOKEN = os.environ.get("API_TOKEN", "")

# AI features (extraction from pasted text, fit score, resume, cover letter)
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
CLAUDE_MODEL = os.environ.get("CLAUDE_MODEL", "claude-sonnet-5-5")

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
