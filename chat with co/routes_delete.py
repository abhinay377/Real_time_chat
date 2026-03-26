"""
routes_delete.py — All DELETE /api/* endpoint handlers.

Covers: single-message delete and full account deletion.
"""

from database import get_db
from auth import get_user, verify_pw, drop_cache


def handle_delete(handler, path):
    """Dispatch DELETE requests to the appropriate handler function."""
    db = get_db()
    try:
        tok = handler._tok()
        me  = get_user(db, tok)
        b   = handler._body()

        if path == "/api/messages/delete":
            if not me:
                return handler._ok({"error": "Unauthorised"}, 401)
            db.execute(
                "UPDATE messages SET deleted=1 WHERE id=? AND sender_id=?",
                (b.get("message_id"), me["id"])
            )
            db.commit()
            return handler._ok({"ok": True})

        if path == "/api/account/delete":
            if not me:
                return handler._ok({"error": "Unauthorised"}, 401)
            pw = b.get("password", "")
            row = db.execute(
                "SELECT password,salt FROM users WHERE id=?", (me["id"],)
            ).fetchone()
            if not verify_pw(pw, row["salt"], row["password"]):
                return handler._ok({"error": "Incorrect password"}, 403)
            uid = me["id"]
            db.execute("DELETE FROM users WHERE id=?", (uid,))
            db.commit()
            drop_cache(user_id=uid)
            return handler._ok({"ok": True, "message": "Your account has been permanently deleted."})

        handler._ok({"error": "Not found"}, 404)

    finally:
        db.close()
