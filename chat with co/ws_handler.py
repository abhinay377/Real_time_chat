"""
ws_handler.py — WebSocket connection handler and server startup.

Handles the full lifecycle of a WebSocket connection:
  auth → message loop (ping, typing, send, read_ack, presence) → cleanup.
"""

import json
import threading
import time

from config import log
from database import get_db
from auth import get_user
from websocket_hub import ws_reg, ws_unreg, ws_alive, ws_push, flush_queue

# ── Check if websockets library is available ───────────────────────────────────
try:
    from websockets.sync.server import serve as ws_serve
    WS_AVAILABLE = True
except ImportError:
    WS_AVAILABLE = False


def handle_ws(ws):
    """
    Handle one WebSocket connection from auth to disconnect.

    Expected first message: {"type": "auth", "token": "..."}
    Then loops on: ping, typing, ws_send, read_ack, presence_query.
    """
    uid       = None
    user_info = None
    ip        = "?"

    try:
        ip = ws.remote_address[0] if ws.remote_address else "?"

        # ── Step 1: Authenticate ───────────────────────────────────────────
        msg = json.loads(ws.recv(timeout=10))
        if msg.get("type") != "auth":
            ws.send(json.dumps({"type": "error", "msg": "First message must be auth"}))
            return

        db = get_db()
        user_info = get_user(db, msg.get("token", ""))
        if not user_info:
            ws.send(json.dumps({"type": "error", "msg": "Invalid token"}))
            db.close()
            return

        uid = user_info["id"]
        db.execute("UPDATE users SET is_online=1,last_seen=? WHERE id=?", (int(time.time()), uid))
        db.commit()
        db.close()

        # ── Step 2: Register & greet ───────────────────────────────────────
        ws_reg(uid, ws)
        ws.send(json.dumps({"type": "auth_ok", "user_id": uid, "ts": int(time.time())}))
        threading.Thread(target=flush_queue, args=(uid,), daemon=True).start()

        log.info("WS connected: user=%d (%s) ip=%s", uid, user_info["name"], ip)

        # ── Step 3: Message loop ───────────────────────────────────────────
        for raw in ws:
            try:
                msg = json.loads(raw)
                t   = msg.get("type")

                if t == "ping":
                    ws.send(json.dumps({"type": "pong", "ts": int(time.time())}))

                elif t == "typing":
                    ws_push(msg.get("to"), {"type": "typing", "from": uid})

                elif t == "ws_send":
                    _handle_ws_send(uid, ws, msg)

                elif t == "read_ack":
                    _handle_read_ack(uid, msg)

                elif t == "presence_query":
                    target = msg.get("user_id")
                    ws.send(json.dumps({
                        "type": "presence_reply",
                        "user_id": target,
                        "online": ws_alive(target),
                    }))

            except json.JSONDecodeError:
                pass
            except Exception as exc:
                log.warning("WS msg error user=%d: %s", uid, exc)

    except Exception as exc:
        log.info("WS closed: user=%s reason=%s", uid, exc)

    finally:
        # ── Step 4: Cleanup ────────────────────────────────────────────────
        if uid:
            ws_unreg(uid, ws)
            if not ws_alive(uid):
                db_f = get_db()
                db_f.execute(
                    "UPDATE users SET is_online=0,last_seen=? WHERE id=?",
                    (int(time.time()), uid)
                )
                db_f.commit()
                db_f.close()
            log.info("WS disconnected: user=%d", uid)


# ── Internal helpers ───────────────────────────────────────────────────────────

def _handle_ws_send(uid, ws, msg):
    """Process a message sent over WebSocket."""
    db = get_db()
    try:
        rid     = msg.get("receiver_id")
        content = (msg.get("content") or "").strip()
        mtype   = msg.get("msg_type", "text")
        furl    = msg.get("file_url")
        fname   = msg.get("file_name")
        fsize   = msg.get("file_size")
        fmime   = msg.get("mime_type")
        cid     = msg.get("client_id")

        if not rid or (not content and not furl):
            return
        if db.execute(
            "SELECT blocked FROM contacts WHERE owner_id=? AND contact_id=? AND blocked=1",
            (rid, uid)
        ).fetchone():
            return

        cur = db.execute(
            "INSERT INTO messages(sender_id,receiver_id,content,msg_type,"
            "file_url,file_name,file_size,mime_type) VALUES(?,?,?,?,?,?,?,?)",
            (uid, rid, content or fname or "", mtype, furl, fname, fsize, fmime)
        )
        db.commit()

        saved = dict(db.execute("SELECT * FROM messages WHERE id=?", (cur.lastrowid,)).fetchone())

        if ws_push(rid, {"type": "new_message", "msg": saved}):
            db.execute("UPDATE messages SET delivered=1 WHERE id=?", (saved["id"],))
            db.commit()
            saved["delivered"] = 1

        ws.send(json.dumps({"type": "msg_sent", "msg": saved, "client_id": cid}))
    finally:
        db.close()


def _handle_read_ack(uid, msg):
    """Mark messages as read and send a receipt to the sender."""
    db = get_db()
    try:
        up_to = msg.get("up_to_id")
        peer  = msg.get("peer_id")
        if up_to and peer:
            now = int(time.time())
            db.execute(
                "UPDATE messages SET read_at=? WHERE id<=? AND sender_id=? "
                "AND receiver_id=? AND read_at IS NULL",
                (now, up_to, peer, uid)
            )
            db.commit()
            ws_push(peer, {"type": "read_receipt", "up_to_id": up_to, "reader": uid, "ts": now})
    finally:
        db.close()


def run_ws():
    """Start the WebSocket server on port 8081."""
    if not WS_AVAILABLE:
        log.warning("'websockets' not installed. Run: pip install websockets")
        return
    with ws_serve(handle_ws, "0.0.0.0", 8081, ping_interval=20, ping_timeout=30) as srv:
        log.info("WebSocket server  ->  ws://localhost:8081")
        srv.serve_forever()
