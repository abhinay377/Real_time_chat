"""
auth.py — Password hashing, token generation, and session lookup.

Uses PBKDF2-SHA256 for passwords and a thread-safe in-memory cache
to avoid hitting the DB on every authenticated request.
"""

import base64
import hashlib
import hmac
import secrets
import threading
import time


def hash_pw(pw, salt):
    """Hash a password with the given salt using PBKDF2-SHA256."""
    return base64.b64encode(
        hashlib.pbkdf2_hmac("sha256", pw.encode(), salt.encode(), 260_000)
    ).decode()


def verify_pw(pw, salt, stored):
    """Return True if *pw* matches the *stored* hash."""
    return hmac.compare_digest(hash_pw(pw, salt), stored)


def new_token():
    """Generate a cryptographically secure 64-char hex token."""
    return secrets.token_hex(32)


# ── Session cache ──────────────────────────────────────────────────────────────
# Keeps recently-looked-up user dicts keyed by session token.
_token_cache: dict = {}
_cache_lock = threading.Lock()


def get_user(conn, token):
    """
    Look up the user for *token*.

    Returns a dict of user columns, or None if invalid/expired.
    Results are cached in memory; evicts oldest half when > 4096 entries.
    """
    if not token:
        return None

    # Try cache first
    with _cache_lock:
        cached = _token_cache.get(token)
    if cached:
        return cached

    # DB lookup
    row = conn.execute(
        "SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id "
        "WHERE s.token=? AND s.ended_at IS NULL",
        (token,)
    ).fetchone()
    if not row:
        return None

    user = dict(row)

    # Touch the session's last_used timestamp
    try:
        conn.execute(
            "UPDATE sessions SET last_used=? WHERE token=?",
            (int(time.time()), token)
        )
        conn.commit()
    except Exception:
        pass

    # Store in cache (with simple eviction)
    with _cache_lock:
        if len(_token_cache) > 4096:
            for k in list(_token_cache)[:2048]:
                del _token_cache[k]
        _token_cache[token] = user

    return user


def drop_cache(token=None, user_id=None):
    """Remove cached entries by token and/or user ID."""
    with _cache_lock:
        if token:
            _token_cache.pop(token, None)
        if user_id:
            for t in [k for k, v in _token_cache.items() if v.get("id") == user_id]:
                del _token_cache[t]
