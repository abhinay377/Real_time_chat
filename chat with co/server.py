"""
server.py — Chat With Co application entrypoint.

Starts the HTTP server on port 8080 and (if websockets is installed)
the WebSocket server on port 8081. All logic lives in dedicated modules:

    config.py         →  paths, constants, logging
    database.py       →  SQLite schema & connection
    auth.py           →  passwords, tokens, session cache
    websocket_hub.py  →  WS registry & push
    ws_handler.py     →  WS message handling
    handler.py        →  HTTP request handler
    routes_get.py     →  GET  /api/* endpoints
    routes_post.py    →  POST /api/* endpoints
    routes_delete.py  →  DELETE /api/* endpoints
"""

import threading
from http.server import HTTPServer
from socketserver import ThreadingMixIn

from config import log, UPLOADS_DIR, DB_PATH
from database import init_db
from handler import Handler
from ws_handler import run_ws, WS_AVAILABLE


class ThreadedServer(ThreadingMixIn, HTTPServer):
    """HTTPServer that handles each request in a new thread."""
    daemon_threads = True


def main():
    """Initialize the database and start both HTTP + WS servers."""
    init_db()

    if WS_AVAILABLE:
        threading.Thread(target=run_ws, daemon=True).start()
    else:
        log.warning("Install websockets: pip install websockets")

    HOST, PORT = "0.0.0.0", 8080
    srv = ThreadedServer((HOST, PORT), Handler)

    log.info("HTTP server  ->  http://localhost:%d", PORT)
    log.info("Uploads      ->  %s", UPLOADS_DIR)
    log.info("Database     ->  %s", DB_PATH)

    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        log.info("Stopped.")


if __name__ == "__main__":
    main()
