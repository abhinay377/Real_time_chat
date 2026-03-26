import logging
from pathlib import Path

# ── Paths ──────────────────────────────────────────────────────────────────────
BASE_DIR    = Path(__file__).parent
STATIC_DIR  = BASE_DIR / "static"
UPLOADS_DIR = STATIC_DIR / "uploads"
DB_PATH     = BASE_DIR / "chatwithco.db"

STATIC_DIR.mkdir(exist_ok=True)
UPLOADS_DIR.mkdir(exist_ok=True)

# ── Upload limits ──────────────────────────────────────────────────────────────
MAX_UPLOAD_MB = 100

ALLOWED_MIME = {
    "image/jpeg", "image/png", "image/gif", "image/webp",
    "image/svg+xml", "image/heic", "image/heif",
    "video/mp4", "video/webm", "video/ogg", "video/quicktime",
    "video/x-msvideo", "video/3gpp",
    "audio/mpeg", "audio/ogg", "audio/wav", "audio/webm",
    "audio/aac", "audio/mp4", "audio/flac",
    "application/pdf", "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/zip", "text/plain", "application/octet-stream",
}

# ── MIME map for static files ──────────────────────────────────────────────────
MIME_MAP = {
    ".html": "text/html; charset=utf-8",
    ".js":   "application/javascript",
    ".css":  "text/css",
    ".png":  "image/png",
    ".jpg":  "image/jpeg",
    ".gif":  "image/gif",
    ".webp": "image/webp",
    ".mp4":  "video/mp4",
    ".webm": "video/webm",
    ".mp3":  "audio/mpeg",
    ".wav":  "audio/wav",
    ".ogg":  "audio/ogg",
    ".pdf":  "application/pdf",
    ".svg":  "image/svg+xml",
    ".ico":  "image/x-icon",
    ".mov":  "video/quicktime",
    ".m4a":  "audio/aac",
    ".aac":  "audio/aac",
    ".3gp":  "video/3gpp",
    ".heic": "image/heic",
    ".heif": "image/heif",
}

# ── Logging ────────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(str(BASE_DIR / "server.log"), encoding="utf-8"),
    ],
)
log = logging.getLogger("CWC")
