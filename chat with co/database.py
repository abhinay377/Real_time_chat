"""
database.py — SQLite connection factory and schema initialization.

Tables: users, sessions, messages, contacts, contact_requests,
        call_log, access_log, user_stories, story_views, message_deletes.
"""

import sqlite3
from config import DB_PATH, log


def get_db():
    """Return a new SQLite connection with recommended PRAGMAs."""
    conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA cache_size=-8000")
    return conn


def init_db():
    """Create all tables and indexes if they don't exist yet."""
    conn = get_db()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            phone       TEXT    UNIQUE NOT NULL,
            name        TEXT    NOT NULL,
            password    TEXT    NOT NULL,
            salt        TEXT    NOT NULL,
            avatar      TEXT    DEFAULT '👤',
            status      TEXT    DEFAULT 'Hey there! I am using Chat With Co.',
            is_online   INTEGER DEFAULT 0,
            created_at  INTEGER DEFAULT (strftime('%s','now')),
            last_seen   INTEGER DEFAULT (strftime('%s','now'))
        );

        CREATE TABLE IF NOT EXISTS sessions (
            token       TEXT    PRIMARY KEY,
            user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            device_name TEXT    DEFAULT 'Browser',
            ip_address  TEXT,
            user_agent  TEXT,
            created_at  INTEGER DEFAULT (strftime('%s','now')),
            last_used   INTEGER DEFAULT (strftime('%s','now')),
            ended_at    INTEGER
        );

        CREATE TABLE IF NOT EXISTS messages (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            sender_id   INTEGER NOT NULL REFERENCES users(id),
            receiver_id INTEGER NOT NULL REFERENCES users(id),
            content     TEXT    NOT NULL,
            msg_type    TEXT    DEFAULT 'text',
            file_url    TEXT,
            file_name   TEXT,
            file_size   INTEGER,
            mime_type   TEXT,
            delivered   INTEGER DEFAULT 0,
            read_at     INTEGER,
            edited_at   INTEGER,
            deleted     INTEGER DEFAULT 0,
            sent_at     INTEGER DEFAULT (strftime('%s','now'))
        );

        CREATE TABLE IF NOT EXISTS contacts (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            owner_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            contact_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            nickname    TEXT,
            blocked     INTEGER DEFAULT 0,
            added_at    INTEGER DEFAULT (strftime('%s','now')),
            UNIQUE(owner_id, contact_id)
        );

        CREATE TABLE IF NOT EXISTS contact_requests (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            from_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            to_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            status      TEXT    DEFAULT 'pending',
            created_at  INTEGER DEFAULT (strftime('%s','now')),
            resolved_at INTEGER,
            UNIQUE(from_id, to_id)
        );

        CREATE TABLE IF NOT EXISTS call_log (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            caller_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            callee_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            call_type   TEXT    NOT NULL,
            status      TEXT    DEFAULT 'missed',
            started_at  INTEGER DEFAULT (strftime('%s','now')),
            answered_at INTEGER,
            ended_at    INTEGER,
            duration_s  INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS access_log (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            event       TEXT    NOT NULL,
            user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
            user_name   TEXT,
            phone       TEXT,
            ip_address  TEXT,
            user_agent  TEXT,
            detail      TEXT,
            ts          INTEGER DEFAULT (strftime('%s','now'))
        );

        CREATE TABLE IF NOT EXISTS user_stories (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            content     TEXT    NOT NULL,
            story_type  TEXT    DEFAULT 'text',
            file_url    TEXT,
            mime_type   TEXT,
            expires_at  INTEGER NOT NULL,
            created_at  INTEGER DEFAULT (strftime('%s','now'))
        );

        CREATE TABLE IF NOT EXISTS story_views (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            story_id    INTEGER NOT NULL REFERENCES user_stories(id) ON DELETE CASCADE,
            viewer_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            viewed_at   INTEGER DEFAULT (strftime('%s','now')),
            UNIQUE(story_id, viewer_id)
        );

        CREATE TABLE IF NOT EXISTS message_deletes (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            message_id  INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
            user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            delete_type TEXT    DEFAULT 'self',
            deleted_at  INTEGER DEFAULT (strftime('%s','now')),
            UNIQUE(message_id, user_id)
        );

        CREATE INDEX IF NOT EXISTS idx_msg_recv_queue ON messages(receiver_id, delivered, sent_at);
        CREATE INDEX IF NOT EXISTS idx_msg_pair       ON messages(sender_id, receiver_id, sent_at);
        CREATE INDEX IF NOT EXISTS idx_sess_token     ON sessions(token, ended_at);
        CREATE INDEX IF NOT EXISTS idx_sess_user      ON sessions(user_id);
        CREATE INDEX IF NOT EXISTS idx_req_to         ON contact_requests(to_id, status);
        CREATE INDEX IF NOT EXISTS idx_stories_user   ON user_stories(user_id, expires_at);
    """)
    conn.commit()
    conn.close()
    log.info("Database ready: %s", DB_PATH)
