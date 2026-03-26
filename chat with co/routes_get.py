"""
routes_get.py — All GET /api/* endpoint handlers.

Each function receives the Handler instance, the URL path,
and the parsed query-string dict.
"""

import time

from database import get_db
from auth import get_user


def handle_get(handler, path, qs):
    """Dispatch GET requests to the appropriate handler function."""
    db = get_db()
    try:
        tok = handler._tok()
        me  = get_user(db, tok)

        if path == "/api/ping":
            from ws_handler import WS_AVAILABLE
            return handler._ok({"ok": True, "ts": int(time.time()), "ws": WS_AVAILABLE})

        if path == "/api/me":
            if not me:
                return handler._ok({"error": "Unauthorised"}, 401)
            return handler._ok({k: v for k, v in me.items() if k not in ("password", "salt")})

        if path == "/api/messages":
            if not me:
                return handler._ok({"error": "Unauthorised"}, 401)
            peer   = int(qs.get("with", [0])[0])
            before = int(qs.get("before", [0])[0]) or None
            limit  = min(int(qs.get("limit", [150])[0]), 300)
            now    = int(time.time())
            db.execute(
                "UPDATE messages SET read_at=? "
                "WHERE sender_id=? AND receiver_id=? AND read_at IS NULL AND deleted=0",
                (now, peer, me["id"])
            )
            db.commit()
            extra = f" AND sent_at<{before}" if before else ""
            rows = db.execute(
                f"SELECT * FROM messages WHERE deleted=0 AND "
                f"id NOT IN (SELECT message_id FROM message_deletes WHERE user_id=?) AND "
                f"((sender_id=? AND receiver_id=?) OR (sender_id=? AND receiver_id=?))"
                f"{extra} ORDER BY sent_at ASC LIMIT ?",
                (me["id"], me["id"], peer, peer, me["id"], limit)
            ).fetchall()
            return handler._ok([dict(r) for r in rows])

        if path == "/api/contacts":
            if not me:
                return handler._ok({"error": "Unauthorised"}, 401)
            rows = db.execute("""
                SELECT c.id, c.contact_id, c.nickname, c.blocked, c.added_at,
                       u.name, u.phone, u.avatar, u.status, u.last_seen, u.is_online,
                       (SELECT COUNT(*) FROM messages m
                        WHERE m.sender_id=c.contact_id AND m.receiver_id=?
                          AND m.read_at IS NULL AND m.deleted=0) AS unread,
                       (SELECT content FROM messages lm
                        WHERE (lm.sender_id=c.contact_id AND lm.receiver_id=?)
                           OR (lm.sender_id=? AND lm.receiver_id=c.contact_id)
                        ORDER BY lm.sent_at DESC LIMIT 1) AS last_msg,
                       (SELECT sent_at FROM messages lt
                        WHERE (lt.sender_id=c.contact_id AND lt.receiver_id=?)
                           OR (lt.sender_id=? AND lt.receiver_id=c.contact_id)
                        ORDER BY lt.sent_at DESC LIMIT 1) AS last_msg_ts
                FROM contacts c JOIN users u ON u.id=c.contact_id
                WHERE c.owner_id=?
                ORDER BY last_msg_ts DESC, u.name
            """, (me["id"],) * 5 + (me["id"],)).fetchall()
            return handler._ok([dict(r) for r in rows])

        if path == "/api/contact-requests":
            if not me:
                return handler._ok({"error": "Unauthorised"}, 401)
            rows = db.execute("""
                SELECT cr.*, u.name AS from_name, u.phone AS from_phone, u.avatar AS from_avatar
                FROM contact_requests cr JOIN users u ON u.id=cr.from_id
                WHERE cr.to_id=? AND cr.status='pending'
                ORDER BY cr.created_at DESC
            """, (me["id"],)).fetchall()
            return handler._ok([dict(r) for r in rows])

        if path == "/api/lookup":
            if not me:
                return handler._ok({"error": "Unauthorised"}, 401)
            phone = qs.get("phone", [""])[0].strip()
            row = db.execute(
                "SELECT id,name,phone,avatar,status FROM users WHERE phone=?", (phone,)
            ).fetchone()
            if not row:
                return handler._ok({"error": "User not found"}, 404)
            return handler._ok(dict(row))

        if path == "/api/calls":
            if not me:
                return handler._ok({"error": "Unauthorised"}, 401)
            rows = db.execute("""
                SELECT cl.*,
                       u1.name AS caller_name, u1.avatar AS caller_avatar,
                       u2.name AS callee_name, u2.avatar AS callee_avatar
                FROM call_log cl
                JOIN users u1 ON u1.id=cl.caller_id
                JOIN users u2 ON u2.id=cl.callee_id
                WHERE cl.caller_id=? OR cl.callee_id=?
                ORDER BY cl.started_at DESC LIMIT 100
            """, (me["id"], me["id"])).fetchall()
            return handler._ok([dict(r) for r in rows])

        if path == "/api/stories":
            if not me:
                return handler._ok({"error": "Unauthorised"}, 401)
            now = int(time.time())
            contact_ids = [r["contact_id"] for r in db.execute(
                "SELECT contact_id FROM contacts WHERE owner_id=?", (me["id"],)
            ).fetchall()]
            contact_ids.append(me["id"])
            placeholders = ",".join("?" * len(contact_ids))
            rows = db.execute(f"""
                SELECT s.*, u.name, u.avatar,
                       (SELECT COUNT(*) FROM story_views sv WHERE sv.story_id=s.id) AS view_count,
                       (SELECT COUNT(*) FROM story_views sv WHERE sv.story_id=s.id AND sv.viewer_id=?) AS i_viewed
                FROM user_stories s JOIN users u ON u.id=s.user_id
                WHERE s.user_id IN ({placeholders}) AND s.expires_at > ?
                ORDER BY s.user_id=? DESC, s.created_at DESC
            """, [me["id"]] + contact_ids + [now, me["id"]]).fetchall()
            return handler._ok([dict(r) for r in rows])

        if path == "/api/story/viewers":
            if not me:
                return handler._ok({"error": "Unauthorised"}, 401)
            story_id = int(qs.get("story_id", [0])[0])
            rows = db.execute("""
                SELECT sv.viewed_at, u.name, u.avatar, u.phone
                FROM story_views sv JOIN users u ON u.id=sv.viewer_id
                WHERE sv.story_id=? AND (SELECT user_id FROM user_stories WHERE id=?)=?
                ORDER BY sv.viewed_at DESC
            """, (story_id, story_id, me["id"])).fetchall()
            return handler._ok([dict(r) for r in rows])

        if path == "/api/contact/profile":
            if not me:
                return handler._ok({"error": "Unauthorised"}, 401)
            uid = int(qs.get("user_id", [0])[0])
            row = db.execute(
                "SELECT id,name,phone,avatar,status,is_online,last_seen FROM users WHERE id=?",
                (uid,)
            ).fetchone()
            if not row:
                return handler._ok({"error": "Not found"}, 404)
            return handler._ok(dict(row))

        handler._ok({"error": "Not found"}, 404)

    finally:
        db.close()
