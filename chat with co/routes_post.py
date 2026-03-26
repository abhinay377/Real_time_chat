"""
routes_post.py — All POST /api/* endpoint handlers.

Covers: registration, login, logout, messaging, contacts,
        uploads, avatar, profile, stories, calls, and message deletion.
"""

import base64
import mimetypes
import secrets
import time
import uuid
from pathlib import Path

from config import UPLOADS_DIR, MAX_UPLOAD_MB
from database import get_db
from auth import hash_pw, verify_pw, new_token, get_user, drop_cache
from websocket_hub import ws_push


def handle_post(handler, path):
    """Dispatch POST requests to the appropriate handler function."""
    db = get_db()
    try:
        tok = handler._tok()
        me  = get_user(db, tok)
        ip  = handler._ip()
        ua  = handler._ua()

        # ── Auth ───────────────────────────────────────────────────────────
        if path == "/api/register":
            return _register(handler, db, ip, ua)

        if path == "/api/login":
            return _login(handler, db, ip, ua)

        if path == "/api/logout":
            return _logout(handler, db, tok, me)

        # ── Messaging ──────────────────────────────────────────────────────
        if path == "/api/send":
            if not me:
                return handler._ok({"error": "Unauthorised"}, 401)
            return _send_message(handler, db, me)

        if path == "/api/messages/clear":
            if not me:
                return handler._ok({"error": "Unauthorised"}, 401)
            return _clear_messages(handler, db, me)

        if path == "/api/messages/delete_for_everyone":
            if not me:
                return handler._ok({"error": "Unauthorised"}, 401)
            return _delete_for_everyone(handler, db, me)

        if path == "/api/messages/delete_for_me":
            if not me:
                return handler._ok({"error": "Unauthorised"}, 401)
            return _delete_for_me(handler, db, me)

        # ── Contacts ───────────────────────────────────────────────────────
        if path == "/api/contacts/request":
            if not me:
                return handler._ok({"error": "Unauthorised"}, 401)
            return _contact_request(handler, db, me)

        if path == "/api/contacts/respond":
            if not me:
                return handler._ok({"error": "Unauthorised"}, 401)
            return _contact_respond(handler, db, me)

        if path == "/api/contacts/block":
            if not me:
                return handler._ok({"error": "Unauthorised"}, 401)
            return _contact_block(handler, db, me)

        # ── Uploads & profile ──────────────────────────────────────────────
        if path == "/api/upload":
            if not me:
                return handler._ok({"error": "Unauthorised"}, 401)
            return _upload_file(handler, me)

        if path == "/api/avatar/upload":
            if not me:
                return handler._ok({"error": "Unauthorised"}, 401)
            return _avatar_upload(handler, db, me)

        if path == "/api/profile/update":
            if not me:
                return handler._ok({"error": "Unauthorised"}, 401)
            return _profile_update(handler, db, me)

        # ── Stories ────────────────────────────────────────────────────────
        if path == "/api/story/post":
            if not me:
                return handler._ok({"error": "Unauthorised"}, 401)
            return _story_post(handler, db, me)

        if path == "/api/story/view":
            if not me:
                return handler._ok({"error": "Unauthorised"}, 401)
            return _story_view(handler, db, me)

        if path == "/api/story/delete":
            if not me:
                return handler._ok({"error": "Unauthorised"}, 401)
            return _story_delete(handler, db, me)

        # ── Calls ──────────────────────────────────────────────────────────
        if path == "/api/call/offer":
            if not me:
                return handler._ok({"error": "Unauthorised"}, 401)
            return _call_offer(handler, db, me)

        if path == "/api/call/answer":
            if not me:
                return handler._ok({"error": "Unauthorised"}, 401)
            return _call_answer(handler, db, me)

        if path == "/api/call/ice":
            if not me:
                return handler._ok({"error": "Unauthorised"}, 401)
            return _call_ice(handler, db, me)

        if path == "/api/call/end":
            if not me:
                return handler._ok({"error": "Unauthorised"}, 401)
            return _call_end(handler, db, me)

        if path == "/api/call/reject":
            if not me:
                return handler._ok({"error": "Unauthorised"}, 401)
            return _call_reject(handler, db, me)

        handler._ok({"error": "Not found"}, 404)

    finally:
        db.close()


# ── Auth helpers ───────────────────────────────────────────────────────────────

def _register(handler, db, ip, ua):
    b = handler._body()
    phone  = (b.get("phone") or "").strip()
    name   = (b.get("name") or "").strip()
    pw     = b.get("password", "")
    device = (b.get("device") or "Browser").strip()

    if not phone or not name or not pw:
        return handler._ok({"error": "All fields required"}, 400)
    if len(pw) < 6:
        return handler._ok({"error": "Password must be >= 6 characters"}, 400)
    if db.execute("SELECT id FROM users WHERE phone=?", (phone,)).fetchone():
        return handler._ok({"error": "Phone already registered"}, 409)

    salt = secrets.token_hex(16)
    db.execute(
        "INSERT INTO users(phone,name,password,salt) VALUES(?,?,?,?)",
        (phone, name, hash_pw(pw, salt), salt)
    )
    db.commit()

    uid = db.execute("SELECT id FROM users WHERE phone=?", (phone,)).fetchone()["id"]
    tok = new_token()
    db.execute(
        "INSERT INTO sessions(token,user_id,device_name,ip_address,user_agent) VALUES(?,?,?,?,?)",
        (tok, uid, device, ip, ua)
    )
    db.commit()

    row = db.execute("SELECT id,name,phone,avatar,status FROM users WHERE id=?", (uid,)).fetchone()
    return handler._ok({"ok": True, "token": tok, "user": dict(row)})


def _login(handler, db, ip, ua):
    b = handler._body()
    phone  = (b.get("phone") or "").strip()
    pw     = b.get("password", "")
    device = (b.get("device") or "Browser").strip()

    row = db.execute("SELECT * FROM users WHERE phone=?", (phone,)).fetchone()
    if not row or not verify_pw(pw, row["salt"], row["password"]):
        return handler._ok({"error": "Invalid phone or password"}, 401)

    existing = db.execute(
        "SELECT token FROM sessions WHERE user_id=? AND device_name=? AND ended_at IS NULL "
        "ORDER BY last_used DESC LIMIT 1", (row["id"], device)
    ).fetchone()

    tok = existing["token"] if existing else new_token()
    if not existing:
        db.execute(
            "INSERT INTO sessions(token,user_id,device_name,ip_address,user_agent) VALUES(?,?,?,?,?)",
            (tok, row["id"], device, ip, ua)
        )

    db.execute(
        "UPDATE sessions SET last_used=?,ip_address=?,user_agent=? WHERE token=?",
        (int(time.time()), ip, ua, tok)
    )
    db.execute(
        "UPDATE users SET last_seen=?,is_online=1 WHERE id=?",
        (int(time.time()), row["id"])
    )
    db.commit()
    drop_cache(token=tok)

    return handler._ok({
        "ok": True, "token": tok,
        "user": {
            "id": row["id"], "name": row["name"],
            "phone": row["phone"], "avatar": row["avatar"],
            "status": row["status"],
        }
    })


def _logout(handler, db, tok, me):
    if tok and me:
        db.execute("UPDATE sessions SET ended_at=? WHERE token=?", (int(time.time()), tok))
        if not db.execute(
            "SELECT token FROM sessions WHERE user_id=? AND ended_at IS NULL LIMIT 1",
            (me["id"],)
        ).fetchone():
            db.execute(
                "UPDATE users SET is_online=0,last_seen=? WHERE id=?",
                (int(time.time()), me["id"])
            )
        db.commit()
        drop_cache(token=tok)
    return handler._ok({"ok": True})


# ── Messaging helpers ──────────────────────────────────────────────────────────

def _send_message(handler, db, me):
    b = handler._body()
    rid     = b.get("receiver_id")
    content = (b.get("content") or "").strip()
    mtype   = b.get("msg_type", "text")
    furl    = b.get("file_url")
    fname   = b.get("file_name")
    fsize   = b.get("file_size")
    fmime   = b.get("mime_type")

    if not rid or (not content and not furl):
        return handler._ok({"error": "receiver_id and content/file required"}, 400)

    if db.execute(
        "SELECT blocked FROM contacts WHERE owner_id=? AND contact_id=? AND blocked=1",
        (rid, me["id"])
    ).fetchone():
        return handler._ok({"error": "You are blocked by this user"}, 403)

    cur = db.execute(
        "INSERT INTO messages(sender_id,receiver_id,content,msg_type,file_url,file_name,file_size,mime_type)"
        " VALUES(?,?,?,?,?,?,?,?)",
        (me["id"], rid, content or fname or "", mtype, furl, fname, fsize, fmime)
    )
    db.commit()

    msg = dict(db.execute("SELECT * FROM messages WHERE id=?", (cur.lastrowid,)).fetchone())
    if ws_push(rid, {"type": "new_message", "msg": msg}):
        db.execute("UPDATE messages SET delivered=1 WHERE id=?", (msg["id"],))
        db.commit()
        msg["delivered"] = 1

    return handler._ok(msg)


def _clear_messages(handler, db, me):
    b = handler._body()
    other = b.get("contact_id")
    db.execute(
        "UPDATE messages SET deleted=1 WHERE "
        "(sender_id=? AND receiver_id=?) OR (sender_id=? AND receiver_id=?)",
        (me["id"], other, other, me["id"])
    )
    db.commit()
    return handler._ok({"ok": True})


def _delete_for_everyone(handler, db, me):
    b = handler._body()
    msg_id = b.get("message_id")
    msg = db.execute(
        "SELECT * FROM messages WHERE id=? AND sender_id=?", (msg_id, me["id"])
    ).fetchone()
    if not msg:
        return handler._ok({"error": "Not found or not your message"}, 404)
    db.execute(
        "UPDATE messages SET deleted=1,content='This message was deleted' WHERE id=?", (msg_id,)
    )
    db.commit()
    ws_push(msg["receiver_id"], {"type": "message_deleted", "message_id": msg_id, "for_everyone": True})
    return handler._ok({"ok": True})


def _delete_for_me(handler, db, me):
    b = handler._body()
    msg_id = b.get("message_id")
    db.execute(
        "INSERT OR IGNORE INTO message_deletes(message_id,user_id,delete_type) VALUES(?,?,'self')",
        (msg_id, me["id"])
    )
    db.commit()
    return handler._ok({"ok": True})


# ── Contact helpers ────────────────────────────────────────────────────────────

def _contact_request(handler, db, me):
    b = handler._body()
    phone    = (b.get("phone") or "").strip()
    nickname = (b.get("nickname") or "").strip()

    target = db.execute("SELECT id,name FROM users WHERE phone=?", (phone,)).fetchone()
    if not target:
        return handler._ok({"error": "No user with that phone number"}, 404)
    if target["id"] == me["id"]:
        return handler._ok({"error": "Cannot add yourself"}, 400)
    if db.execute(
        "SELECT id FROM contacts WHERE owner_id=? AND contact_id=?",
        (me["id"], target["id"])
    ).fetchone():
        return handler._ok({"error": "Already in your contacts"}, 409)

    existing_req = db.execute(
        "SELECT id,status FROM contact_requests WHERE from_id=? AND to_id=?",
        (me["id"], target["id"])
    ).fetchone()

    if existing_req:
        if existing_req["status"] == "pending":
            return handler._ok({"error": "Request already sent — waiting for acceptance"}, 409)
        db.execute(
            "UPDATE contact_requests SET status='pending',created_at=? WHERE id=?",
            (int(time.time()), existing_req["id"])
        )
        db.commit()
        req_id = existing_req["id"]
    else:
        cur = db.execute(
            "INSERT INTO contact_requests(from_id,to_id) VALUES(?,?)",
            (me["id"], target["id"])
        )
        db.commit()
        req_id = cur.lastrowid

    ws_push(target["id"], {
        "type": "contact_request",
        "request_id": req_id,
        "from_id": me["id"],
        "from_name": me["name"],
        "from_phone": me["phone"],
        "from_avatar": me.get("avatar", "👤"),
    })
    return handler._ok({"ok": True, "name": target["name"], "pending": True})


def _contact_respond(handler, db, me):
    b = handler._body()
    req_id = b.get("request_id")
    accept = bool(b.get("accept", False))

    req = db.execute(
        "SELECT * FROM contact_requests WHERE id=? AND to_id=? AND status='pending'",
        (req_id, me["id"])
    ).fetchone()
    if not req:
        return handler._ok({"error": "Request not found"}, 404)

    now = int(time.time())
    status = "accepted" if accept else "declined"
    db.execute("UPDATE contact_requests SET status=?,resolved_at=? WHERE id=?", (status, now, req_id))
    db.commit()

    if accept:
        try:
            db.execute("INSERT OR IGNORE INTO contacts(owner_id,contact_id) VALUES(?,?)",
                       (me["id"], req["from_id"]))
            db.execute("INSERT OR IGNORE INTO contacts(owner_id,contact_id) VALUES(?,?)",
                       (req["from_id"], me["id"]))
            db.commit()
        except Exception:
            pass
        ws_push(req["from_id"], {
            "type": "contact_accepted",
            "by_id": me["id"],
            "by_name": me["name"],
            "by_phone": me["phone"],
            "by_avatar": me.get("avatar", "👤"),
        })
        return handler._ok({"ok": True, "accepted": True, "contact_id": req["from_id"]})
    else:
        ws_push(req["from_id"], {
            "type": "contact_declined",
            "by_id": me["id"],
            "by_name": me["name"],
        })
        return handler._ok({"ok": True, "accepted": False})


def _contact_block(handler, db, me):
    b = handler._body()
    db.execute(
        "UPDATE contacts SET blocked=? WHERE owner_id=? AND contact_id=?",
        (int(b.get("blocked", 1)), me["id"], b.get("contact_id"))
    )
    db.commit()
    return handler._ok({"ok": True})


# ── Upload helpers ─────────────────────────────────────────────────────────────

def _upload_file(handler, me):
    ct = handler.headers.get("Content-Type", "")
    if "multipart/form-data" not in ct:
        return handler._ok({"error": "multipart/form-data required"}, 400)

    data = handler._raw()
    boundary = ct.split("boundary=")[-1].strip().encode()

    for part in data.split(b"--" + boundary)[1:]:
        if b"\r\n\r\n" not in part:
            continue
        hdr, bdy = part.split(b"\r\n\r\n", 1)
        bdy = bdy.rstrip(b"\r\n--")
        hdr_s = hdr.decode("utf-8", errors="replace")
        if "filename=" not in hdr_s:
            continue

        fn_parts = [x for x in hdr_s.split(";") if "filename=" in x]
        if not fn_parts:
            continue
        orig = fn_parts[0].split("filename=")[-1].strip().strip('"')
        mime, _ = mimetypes.guess_type(orig)
        if not mime:
            mime = "application/octet-stream"

        if len(bdy) > MAX_UPLOAD_MB * 1024 * 1024:
            return handler._ok({"error": f"File exceeds {MAX_UPLOAD_MB}MB"}, 413)

        ext  = Path(orig).suffix.lower()
        name = uuid.uuid4().hex + ext
        (UPLOADS_DIR / name).write_bytes(bdy)
        return handler._ok({
            "ok": True, "url": f"/uploads/{name}",
            "filename": orig, "size": len(bdy), "mime": mime,
        })

    return handler._ok({"error": "No file in request"}, 400)


def _avatar_upload(handler, db, me):
    ct = handler.headers.get("Content-Type", "")
    if "multipart/form-data" not in ct:
        return handler._ok({"error": "multipart/form-data required"}, 400)

    data = handler._raw()
    boundary = ct.split("boundary=")[-1].strip().encode()

    for part in data.split(b"--" + boundary)[1:]:
        if b"\r\n\r\n" not in part:
            continue
        hdr, bdy = part.split(b"\r\n\r\n", 1)
        bdy = bdy.rstrip(b"\r\n--")
        hdr_s = hdr.decode("utf-8", errors="replace")
        if "filename=" not in hdr_s and "name=" not in hdr_s:
            continue

        mime, _ = mimetypes.guess_type(
            hdr_s.split("filename=")[-1].strip().strip('"') if "filename=" in hdr_s else "file.jpg"
        )
        if not mime:
            mime = "image/jpeg"
        if not mime.startswith("image/"):
            return handler._ok({"error": "Only image files allowed for avatar"}, 415)
        if len(bdy) > 5 * 1024 * 1024:
            return handler._ok({"error": "Avatar must be < 5MB"}, 413)

        b64 = base64.b64encode(bdy).decode()
        data_url = f"data:{mime};base64,{b64}"
        db.execute("UPDATE users SET avatar=? WHERE id=?", (data_url, me["id"]))
        db.commit()
        drop_cache(user_id=me["id"])

        contacts = db.execute(
            "SELECT contact_id FROM contacts WHERE owner_id=?", (me["id"],)
        ).fetchall()
        for row in contacts:
            ws_push(row["contact_id"], {"type": "profile_update", "user_id": me["id"], "avatar": data_url})

        return handler._ok({"ok": True, "avatar": data_url})

    return handler._ok({"error": "No image found in request"}, 400)


def _profile_update(handler, db, me):
    b = handler._body()
    new_name   = (b.get("name") or me["name"]).strip()
    new_status = (b.get("status") or me["status"]).strip()
    new_avatar = b.get("avatar", me["avatar"])

    db.execute(
        "UPDATE users SET name=?,status=?,avatar=? WHERE id=?",
        (new_name, new_status, new_avatar, me["id"])
    )
    db.commit()
    drop_cache(user_id=me["id"])

    contacts = db.execute("SELECT contact_id FROM contacts WHERE owner_id=?", (me["id"],)).fetchall()
    for row in contacts:
        ws_push(row["contact_id"], {
            "type": "profile_update", "user_id": me["id"],
            "name": new_name, "status": new_status, "avatar": new_avatar,
        })
    return handler._ok({"ok": True})


# ── Story helpers ──────────────────────────────────────────────────────────────

def _story_post(handler, db, me):
    b = handler._body()
    content = (b.get("content") or "").strip()
    stype   = b.get("story_type", "text")
    furl    = b.get("file_url")
    mime    = b.get("mime_type")
    if not content and not furl:
        return handler._ok({"error": "Content required"}, 400)
    expires = int(time.time()) + 86400  # 24 hours
    cur = db.execute(
        "INSERT INTO user_stories(user_id,content,story_type,file_url,mime_type,expires_at) VALUES(?,?,?,?,?,?)",
        (me["id"], content or "", stype, furl, mime, expires)
    )
    db.commit()
    return handler._ok({"ok": True, "story_id": cur.lastrowid})


def _story_view(handler, db, me):
    b = handler._body()
    story_id = b.get("story_id")
    if story_id:
        db.execute(
            "INSERT OR IGNORE INTO story_views(story_id,viewer_id) VALUES(?,?)",
            (story_id, me["id"])
        )
        db.commit()
    return handler._ok({"ok": True})


def _story_delete(handler, db, me):
    b = handler._body()
    story_id = b.get("story_id")
    db.execute("DELETE FROM user_stories WHERE id=? AND user_id=?", (story_id, me["id"]))
    db.commit()
    return handler._ok({"ok": True})


# ── Call helpers ───────────────────────────────────────────────────────────────

def _call_offer(handler, db, me):
    b = handler._body()
    callee_id = b.get("callee_id")
    ctype     = b.get("call_type", "audio")
    sdp       = b.get("sdp")
    if not callee_id or not sdp:
        return handler._ok({"error": "callee_id and sdp required"}, 400)

    cur = db.execute(
        "INSERT INTO call_log(caller_id,callee_id,call_type,status) VALUES(?,?,?,'ringing')",
        (me["id"], callee_id, ctype)
    )
    call_id = cur.lastrowid
    db.commit()

    ws_push(callee_id, {
        "type": "call_offer", "call_id": call_id, "call_type": ctype,
        "from": me["id"], "from_name": me["name"], "from_avatar": me["avatar"], "sdp": sdp,
    })
    return handler._ok({"ok": True, "call_id": call_id})


def _call_answer(handler, db, me):
    b = handler._body()
    call_id = b.get("call_id")
    sdp     = b.get("sdp")
    call = db.execute("SELECT * FROM call_log WHERE id=?", (call_id,)).fetchone()
    if not call:
        return handler._ok({"error": "Call not found"}, 404)
    db.execute(
        "UPDATE call_log SET status='answered',answered_at=? WHERE id=?",
        (int(time.time()), call_id)
    )
    db.commit()
    ws_push(call["caller_id"], {"type": "call_answer", "call_id": call_id, "from": me["id"], "sdp": sdp})
    return handler._ok({"ok": True})


def _call_ice(handler, db, me):
    b = handler._body()
    ws_push(b.get("target_id"), {
        "type": "ice_candidate", "call_id": b.get("call_id"),
        "from": me["id"], "candidate": b.get("candidate"),
    })
    return handler._ok({"ok": True})


def _call_end(handler, db, me):
    b = handler._body()
    call_id = b.get("call_id")
    call = db.execute("SELECT * FROM call_log WHERE id=?", (call_id,)).fetchone()
    if call:
        now = int(time.time())
        dur = (now - call["answered_at"]) if call["answered_at"] else 0
        db.execute(
            "UPDATE call_log SET status='ended',ended_at=?,duration_s=? WHERE id=?",
            (now, dur, call_id)
        )
        db.commit()
        other = call["callee_id"] if call["caller_id"] == me["id"] else call["caller_id"]
        ws_push(other, {"type": "call_ended", "call_id": call_id})
    return handler._ok({"ok": True})


def _call_reject(handler, db, me):
    b = handler._body()
    call_id = b.get("call_id")
    call = db.execute("SELECT * FROM call_log WHERE id=?", (call_id,)).fetchone()
    if call:
        db.execute("UPDATE call_log SET status='rejected' WHERE id=?", (call_id,))
        db.commit()
        ws_push(call["caller_id"], {"type": "call_rejected", "call_id": call_id})
    return handler._ok({"ok": True})
