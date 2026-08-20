"""
cleanup_orphaned_images.py — manual, on-demand janitor: finds image files
under database.IMAGES_DIR that no message row points at any more (e.g. left
behind by a crash between a DB delete committing and its file cleanup
running) and removes them.

Never run automatically — only invoke this yourself when you want to
reclaim space. Defaults to a dry run; pass --delete to actually remove
files.

Run with:
    python cleanup_orphaned_images.py            # dry run, lists orphans
    python cleanup_orphaned_images.py --delete    # actually deletes them
"""
import os
import sys

import database as db


def find_orphans():
    with db.get_connection() as conn:
        referenced = {
            row["image_path"] for row in conn.execute(
                "SELECT image_path FROM messages WHERE image_path IS NOT NULL"
            )
        }

    orphans = []
    if not os.path.isdir(db.IMAGES_DIR):
        return orphans

    for conv_dir in os.listdir(db.IMAGES_DIR):
        full_conv_dir = os.path.join(db.IMAGES_DIR, conv_dir)
        if not os.path.isdir(full_conv_dir):
            continue
        for filename in os.listdir(full_conv_dir):
            rel_path = f"{conv_dir}/{filename}"
            if rel_path not in referenced:
                orphans.append(rel_path)

    return orphans


def main():
    delete = "--delete" in sys.argv
    orphans = find_orphans()

    if not orphans:
        print("No orphaned image files found.")
        return

    print(f"Found {len(orphans)} orphaned image file(s):")
    for rel_path in orphans:
        print(f"  {rel_path}")

    if not delete:
        print()
        print("Dry run — nothing deleted. Re-run with --delete to remove these files.")
        return

    print()
    removed = 0
    for rel_path in orphans:
        try:
            os.remove(os.path.join(db.IMAGES_DIR, rel_path))
            removed += 1
        except OSError as e:
            print(f"  could not remove {rel_path}: {e}")
    print(f"Removed {removed}/{len(orphans)} orphaned file(s).")


if __name__ == "__main__":
    main()
