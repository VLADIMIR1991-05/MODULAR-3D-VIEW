#!/usr/bin/env python3
"""Create a portable, lossless JSON backup of the Render PostgreSQL database."""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import decimal
import gzip
import hashlib
import json
import os
import uuid

import psycopg
from psycopg.rows import dict_row


def encode(value):
    if isinstance(value, bytes):
        return {"$type": "bytes", "base64": base64.b64encode(value).decode("ascii")}
    if isinstance(value, (dt.datetime, dt.date, dt.time)):
        return {"$type": type(value).__name__, "value": value.isoformat()}
    if isinstance(value, decimal.Decimal):
        return {"$type": "decimal", "value": str(value)}
    if isinstance(value, uuid.UUID):
        return {"$type": "uuid", "value": str(value)}
    return value


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    database_url = os.environ["RENDER_DATABASE_URL"]

    backup = {
        "format": "modular3d-render-postgres-backup-v1",
        "created_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "tables": {},
    }

    with psycopg.connect(database_url, row_factory=dict_row) as connection:
        connection.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        tables = connection.execute(
            """
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
            ORDER BY table_name
            """
        ).fetchall()

        for table_row in tables:
            table = table_row["table_name"]
            columns = connection.execute(
                """
                SELECT column_name, data_type, udt_name, is_nullable,
                       column_default, ordinal_position
                FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = %s
                ORDER BY ordinal_position
                """,
                (table,),
            ).fetchall()
            rows = connection.execute(
                f'SELECT * FROM "{table.replace(chr(34), chr(34) * 2)}" ORDER BY 1'
            ).fetchall()
            backup["tables"][table] = {
                "columns": columns,
                "rows": [{key: encode(value) for key, value in row.items()} for row in rows],
                "row_count": len(rows),
            }

    raw = json.dumps(backup, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    with gzip.open(args.output, "wb", compresslevel=9) as stream:
        stream.write(raw)
    digest = hashlib.sha256(open(args.output, "rb").read()).hexdigest()
    print(json.dumps({
        "output": args.output,
        "sha256": digest,
        "tables": {name: data["row_count"] for name, data in backup["tables"].items()},
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
