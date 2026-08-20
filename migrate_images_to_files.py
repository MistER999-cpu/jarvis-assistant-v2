"""
migrate_images_to_files.py — one-time backfill: extracts existing base64
images out of messages.image_data and writes them to files under
database.IMAGES_DIR, populating messages.image_path to point at them.

Safe to interrupt and re-run: it skips any row that already has an
image_path, and it never modifies or clears image_data — the original
base64 stays in the DB as a redundant safety copy. Also makes a timestamped
backup of the whole jarvis.db file before touching anything.

This does NOT null out image_data when finished — that's a separate,
deliberate cleanup step (run cleanup_null_legacy_image_data manually, or
just the one UPDATE it prints) for after you've verified images still
render and analyze correctly.

Run with:
    python migrate_images_to_files.py
"""
import os
import shutil
import sys
from datetime import datetime

import database as db


def backup_db():
    if not os.path.exists(db.DB_PATH):
        print(f"No database found at {db.DB_PATH} — nothing to back up or migrate.")
        sys.exit(0)
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_path = f"{db.DB_PATH}.bak-{timestamp}"
    shutil.copy2(db.DB_PATH, backup_path)
    print(f"Backed up {db.DB_PATH} -> {backup_path}")
    return backup_path


def migrate():
    db.init_db()  # make sure image_path column + IMAGES_DIR exist

    with db.get_connection() as conn:
        rows = conn.execute(
            "SELECT id, conversation_id, image_data FROM messages "
            "WHERE image_data IS NOT NULL AND image_path IS NULL"
        ).fetchall()

    print(f"Found {len(rows)} message(s) with unmigrated base64 image data.")
    if not rows:
        return

    migrated = 0
    failed = []
    for row in rows:
        message_id = row["id"]
        conversation_id = row["conversation_id"]
        try:
            image_path = db._save_image_file(conversation_id, message_id, row["image_data"])
        except Exception as e:
            failed.append((message_id, str(e)))
            print(f"  FAILED message {message_id}: {e}")
            continue

        with db.get_connection() as conn:
            conn.execute("UPDATE messages SET image_path = ? WHERE id = ?", (image_path, message_id))
            conn.commit()

        migrated += 1
        print(f"  message {message_id} (conversation {conversation_id}) -> {image_path}")

    print()
    print(f"Migrated {migrated}/{len(rows)} message(s).")
    if failed:
        print(f"{len(failed)} failed and were left untouched (image_data still intact for those rows):")
        for message_id, err in failed:
            print(f"  - message {message_id}: {err}")

    print()
    print("image_data was left untouched for every row (migrated or not) as a safety copy.")
    print("Once you've verified images render and analyze correctly, you can reclaim the")
    print("space it's using by running this SQL yourself (NOT done automatically):")
    print()
    print("    UPDATE messages SET image_data = NULL WHERE image_path IS NOT NULL;")


if __name__ == "__main__":
    backup_db()
    migrate()
