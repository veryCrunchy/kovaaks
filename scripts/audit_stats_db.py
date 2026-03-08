#!/usr/bin/env python3
import argparse
import os
import sqlite3
import sys
from collections import Counter
from pathlib import Path


def default_db_path() -> Path | None:
    env_path = os.environ.get("KOVAAKS_STATS_DB")
    if env_path:
        return Path(env_path)

    appdata = os.environ.get("APPDATA")
    if appdata:
        return Path(appdata) / "com.verycrunchy.kovaaks" / "stats.sqlite3"

    return Path.home() / ".local" / "share" / "com.verycrunchy.kovaaks" / "stats.sqlite3"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Audit AimMod session integrity rows in stats.sqlite3")
    parser.add_argument("--db", type=Path, default=default_db_path(), help="Path to stats.sqlite3")
    parser.add_argument("--limit", type=int, default=25, help="How many incomplete sessions to print")
    return parser.parse_args()


def ensure_columns(conn: sqlite3.Connection) -> None:
    columns = {row[1] for row in conn.execute("PRAGMA table_info(sessions)")}
    required = {"integrity_status", "integrity_failure_codes", "integrity_checked_at_unix_ms"}
    missing = sorted(required - columns)
    if missing:
        raise RuntimeError(
            "sessions table is missing integrity columns: "
            + ", ".join(missing)
            + ". Open AimMod once on the current build to migrate the DB."
        )


def main() -> int:
    args = parse_args()
    db_path = args.db
    if db_path is None or not db_path.exists():
        print("stats db not found; pass --db /path/to/stats.sqlite3", file=sys.stderr)
        return 2

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row

    try:
        ensure_columns(conn)
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 2

    incomplete_rows = list(
        conn.execute(
            """
            SELECT id, scenario, timestamp, integrity_status, integrity_failure_codes
            FROM sessions
            WHERE integrity_status <> 'ok'
            ORDER BY timestamp DESC, id DESC
            LIMIT ?
            """,
            (max(1, args.limit),),
        )
    )

    all_incomplete_rows = list(
        conn.execute(
            """
            SELECT integrity_failure_codes
            FROM sessions
            WHERE integrity_status <> 'ok'
            """
        )
    )
    failure_counts: Counter[str] = Counter()
    for row in all_incomplete_rows:
        raw = row[0] or ""
        for code in raw.split(","):
            code = code.strip()
            if code:
                failure_counts[code] += 1

    orphan_replay_assets = list(
        conn.execute(
            """
            SELECT ra.session_id, ra.file_path
            FROM replay_assets ra
            LEFT JOIN sessions s ON s.id = ra.session_id
            WHERE s.id IS NULL
            ORDER BY ra.updated_at_unix_ms DESC, ra.session_id DESC
            """
        )
    )

    total_sessions = conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
    unknown_sessions = conn.execute(
        "SELECT COUNT(*) FROM sessions WHERE integrity_status = 'unknown'"
    ).fetchone()[0]

    print(f"DB: {db_path}")
    print(f"Sessions: {total_sessions}")
    print(f"Incomplete sessions: {len(all_incomplete_rows)}")
    print(f"Unknown integrity rows: {unknown_sessions}")
    print(f"Orphan replay assets: {len(orphan_replay_assets)}")

    if failure_counts:
        print("\nFailure counts:")
        for code, count in failure_counts.most_common():
            print(f"  {count:5d}  {code}")

    if incomplete_rows:
        print("\nIncomplete sessions:")
        for row in incomplete_rows:
            print(
                f"  {row['timestamp']}  {row['id']}  status={row['integrity_status']}  codes={row['integrity_failure_codes'] or '-'}"
            )
            print(f"    scenario={row['scenario']}")

    if orphan_replay_assets:
        print("\nOrphan replay assets:")
        for row in orphan_replay_assets[: args.limit]:
            print(f"  {row['session_id']}  {row['file_path']}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())