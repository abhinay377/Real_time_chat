"""
websocket_hub.py — WebSocket connection registry and message delivery.

Tracks which users have active WebSocket connections and provides
push-to-user and offline-queue-flush capabilities.
"""

import json
import threading

from database import get_db


# ── Connection registry ────────────────────────────────────────────────────────
# Maps user-id → list of active WebSocket objects.
_connections: dict[int, list] = {}
_lock = threading.Lock()


def ws_reg(uid, ws):
    """Register a WebSocket for *uid*."""
    with _lock:
        _connections.setdefault(uid, []).append(ws)


def ws_unreg(uid, ws):
    """Unregister a WebSocket for *uid*."""
    with _lock:
        if ws in _connections.get(uid, []):
            _connections[uid].remove(ws)


def ws_alive(uid):
    """Return True if *uid* has at least one live WebSocket."""
    with _lock:
        return bool(_connections.get(uid))


def ws_push(uid, payload):
    """
    Send *payload* (dict) as JSON to all of *uid*'s WebSockets.

    Returns True if at least one send succeeded.
    Automatically cleans up dead connections.
    """
    if not uid:
        return False

    data = json.dumps(payload)

    with _lock:
        targets = list(_connections.get(uid, []))
    if not targets:
        return False

    ok = False
    dead = []
    for ws in targets:
        try:
            ws.send(data)
            ok = True
        except Exception:
            dead.append(ws)

    # Remove dead sockets
    if dead:
        with _lock:
            for d in dead:
                try:
                    _connections.get(uid, []).remove(d)
                except Exception:
                    pass

    return ok


def flush_queue(uid):
    """
    Deliver all undelivered messages and pending contact requests
    to *uid* via their WebSocket connections.
    """
    db = get_db()
    try:
        # Pending messages
        rows = db.execute(
            "SELECT * FROM messages WHERE receiver_id=? AND delivered=0 AND deleted=0"
            " ORDER BY sent_at ASC", (uid,)
        ).fetchall()

        pushed = []
        for r in rows:
            if ws_push(uid, {"type": "new_message", "msg": dict(r)}):
                pushed.append(r["id"])

        if pushed:
            db.execute(
                f"UPDATE messages SET delivered=1 WHERE id IN ({','.join('?' * len(pushed))})",
                pushed
            )
            db.commit()

        # Pending contact requests
        reqs = db.execute(
            """SELECT cr.*, u.name AS from_name, u.phone AS from_phone, u.avatar AS from_avatar
               FROM contact_requests cr JOIN users u ON u.id=cr.from_id
               WHERE cr.to_id=? AND cr.status='pending'""", (uid,)
        ).fetchall()

        for req in reqs:
            ws_push(uid, {
                "type": "contact_request",
                "request_id": req["id"],
                "from_id": req["from_id"],
                "from_name": req["from_name"],
                "from_phone": req["from_phone"],
                "from_avatar": req["from_avatar"],
            })
    finally:
        db.close()
