"""
handler.py — HTTP request handler and static file serving.

Routes API requests to routes_get, routes_post, and routes_delete.
Serves static files from the /static directory.
"""

import json
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

from config import STATIC_DIR, MIME_MAP
from routes_get import handle_get
from routes_post import handle_post
from routes_delete import handle_delete


class Handler(BaseHTTPRequestHandler):
    """Threaded HTTP handler for Chat With Co."""

    # Suppress default access-log output
    def log_message(self, *_):
        pass

    # ── Helper methods (used by route handlers) ────────────────────────────

    def _ip(self):
        """Client IP, respecting reverse-proxy headers."""
        return (self.headers.get("X-Forwarded-For")
                or self.headers.get("X-Real-IP")
                or self.client_address[0])

    def _ua(self):
        """Client User-Agent string."""
        return self.headers.get("User-Agent", "")

    def _ok(self, data, code=200):
        """Send a JSON response with CORS headers."""
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type,Authorization")
        self.end_headers()
        self.wfile.write(body)

    def _raw(self):
        """Read the raw request body bytes."""
        n = int(self.headers.get("Content-Length", 0))
        return self.rfile.read(n) if n else b""

    def _body(self):
        """Parse and return the JSON request body as a dict."""
        try:
            return json.loads(self._raw()) or {}
        except Exception:
            return {}

    def _tok(self):
        """Extract the Bearer token from the Authorization header."""
        h = self.headers.get("Authorization", "")
        return h[7:] if h.startswith("Bearer ") else None

    # ── HTTP method dispatchers ────────────────────────────────────────────

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type,Authorization")
        self.end_headers()

    def do_GET(self):
        p = urlparse(self.path)
        if p.path.startswith("/api/"):
            handle_get(self, p.path, parse_qs(p.query))
        else:
            self._static(p.path)

    def do_POST(self):
        p = urlparse(self.path).path
        if p.startswith("/api/"):
            handle_post(self, p)
        else:
            self._ok({"error": "Not found"}, 404)

    def do_DELETE(self):
        p = urlparse(self.path).path
        if p.startswith("/api/"):
            handle_delete(self, p)
        else:
            self._ok({"error": "Not found"}, 404)

    # ── Static file server ─────────────────────────────────────────────────

    def _static(self, path):
        """Serve a file from the static directory."""
        if path in ("/", "/index.html", ""):
            path = "/index.html"

        fp = STATIC_DIR / path.lstrip("/")
        if not fp.exists() or not fp.is_file():
            self._ok({"error": "Not found"}, 404)
            return

        data = fp.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", MIME_MAP.get(fp.suffix.lower(), "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control",
                         "no-cache" if fp.suffix == ".html" else "public,max-age=86400")
        self.end_headers()
        self.wfile.write(data)
