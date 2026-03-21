#!/usr/bin/env python3
import argparse
import json
import sqlite3
from pathlib import Path


def parse_args():
    parser = argparse.ArgumentParser(
        description="Update OpenWebUI user setting ui.collapseCodeBlocks."
    )
    parser.add_argument(
        "--db",
        default="/app/backend/data/webui.db",
        help="Path to the OpenWebUI SQLite database.",
    )
    parser.add_argument(
        "--email",
        action="append",
        default=[],
        help="Limit updates to a specific user email. Can be repeated.",
    )
    parser.add_argument(
        "--value",
        choices=("on", "off"),
        default="off",
        help="Desired collapseCodeBlocks value. Default: off",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would change without writing to the database.",
    )
    return parser.parse_args()


def main():
    args = parse_args()
    db_path = Path(args.db)
    target_value = args.value == "on"

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    query = "SELECT id, email, settings FROM user"
    params = []
    if args.email:
        placeholders = ",".join("?" for _ in args.email)
        query += f" WHERE email IN ({placeholders})"
        params.extend(args.email)
    query += " ORDER BY email"

    rows = cur.execute(query, params).fetchall()
    changed = 0

    for row in rows:
        settings = json.loads(row["settings"]) if row["settings"] else {}
        ui = settings.setdefault("ui", {})
        old_value = ui.get("collapseCodeBlocks")
        ui["collapseCodeBlocks"] = target_value

        state = "unchanged" if old_value == target_value else "updated"
        print(f"{state}: {row['email']} {old_value!r} -> {target_value!r}")

        if old_value != target_value:
            changed += 1
            if not args.dry_run:
                cur.execute(
                    "UPDATE user SET settings = ? WHERE id = ?",
                    (json.dumps(settings, ensure_ascii=False), row["id"]),
                )

    if not args.dry_run and changed:
        conn.commit()

    print(f"users={len(rows)} changed={changed} dry_run={args.dry_run}")


if __name__ == "__main__":
    main()
