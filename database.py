"""
database.py — Jarvis SQLite data access layer.

Single local file: F:\\Jarvis\\data\\jarvis.db
No server, no installation needed: SQLite is just a file.
"""

import sqlite3
import os
from datetime import datetime
from contextlib import contextmanager

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "jarvis.db")


def init_db():
    """Creates tables if they don't exist yet, and migrates existing ones. Call at app startup."""
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    with get_connection() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS conversations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL DEFAULT 'New conversation',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id INTEGER NOT NULL,
                role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
                content TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id)")

        # Migration: add image_data to any messages table created before image
        # upload support existed. CREATE TABLE IF NOT EXISTS above is a no-op on
        # an existing table, so a new column has to be added explicitly here.
        existing_columns = {row["name"] for row in conn.execute("PRAGMA table_info(messages)")}
        if "image_data" not in existing_columns:
            conn.execute("ALTER TABLE messages ADD COLUMN image_data TEXT")

        conn.commit()


@contextmanager
def get_connection():
    """Context manager for a SQLite connection with foreign keys enabled."""
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA foreign_keys = ON")
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()


def _now():
    return datetime.utcnow().isoformat()


# ---------- Conversations ----------

def create_conversation(title="New conversation"):
    with get_connection() as conn:
        cur = conn.execute(
            "INSERT INTO conversations (title, created_at, updated_at) VALUES (?, ?, ?)",
            (title, _now(), _now())
        )
        conn.commit()
        return cur.lastrowid


def list_conversations():
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT id, title, created_at, updated_at FROM conversations ORDER BY updated_at DESC"
        ).fetchall()
        return [dict(r) for r in rows]


def get_conversation(conversation_id):
    with get_connection() as conn:
        row = conn.execute(
            "SELECT id, title, created_at, updated_at FROM conversations WHERE id = ?",
            (conversation_id,)
        ).fetchone()
        return dict(row) if row else None


def rename_conversation(conversation_id, new_title):
    with get_connection() as conn:
        conn.execute(
            "UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?",
            (new_title, _now(), conversation_id)
        )
        conn.commit()


def touch_conversation(conversation_id):
    """Updates updated_at (called on every new message) so recency sorting works."""
    with get_connection() as conn:
        conn.execute(
            "UPDATE conversations SET updated_at = ? WHERE id = ?",
            (_now(), conversation_id)
        )
        conn.commit()


def delete_conversation(conversation_id):
    with get_connection() as conn:
        conn.execute("DELETE FROM conversations WHERE id = ?", (conversation_id,))
        conn.commit()


# ---------- Messages ----------

def add_message(conversation_id, role, content, image_data=None):
    """
    image_data, when present, is a base64-encoded data URL string
    (e.g. "data:image/png;base64,...") for a user-attached image.
    """
    with get_connection() as conn:
        cur = conn.execute(
            "INSERT INTO messages (conversation_id, role, content, created_at, image_data) VALUES (?, ?, ?, ?, ?)",
            (conversation_id, role, content, _now(), image_data)
        )
        conn.commit()
        touch_conversation(conversation_id)
        return cur.lastrowid


def get_messages(conversation_id):
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT id, role, content, created_at, image_data FROM messages WHERE conversation_id = ? ORDER BY id ASC",
            (conversation_id,)
        ).fetchall()
        return [dict(r) for r in rows]


def update_message(message_id, new_content):
    with get_connection() as conn:
        conn.execute(
            "UPDATE messages SET content = ? WHERE id = ?",
            (new_content, message_id)
        )
        conn.commit()


def delete_messages_after(conversation_id, message_id):
    """
    Deletes every message in a conversation with id >= message_id.
    Used for "edit a message and regenerate": cuts everything that follows.
    """
    with get_connection() as conn:
        conn.execute(
            "DELETE FROM messages WHERE conversation_id = ? AND id >= ?",
            (conversation_id, message_id)
        )
        conn.commit()


def delete_last_assistant_message(conversation_id):
    """Used for 'regenerate the last reply': deletes only the last assistant message."""
    with get_connection() as conn:
        row = conn.execute(
            "SELECT id FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1",
            (conversation_id,)
        ).fetchone()
        if row:
            conn.execute("DELETE FROM messages WHERE id = ?", (row["id"],))
            conn.commit()
        return row["id"] if row else None