#!/usr/bin/env python3
"""Convert the private Render backup into a D1 import and R2 release files."""

from __future__ import annotations

import argparse
import base64
import gzip
import hashlib
import json
import re
from pathlib import Path


def decode(value):
    if isinstance(value, dict) and value.get("$type") == "bytes":
        return base64.b64decode(value["base64"])
    if isinstance(value, dict) and "value" in value:
        return value["value"]
    return value


def sql_literal(value) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def clean_filename(value: str) -> str:
    filename = Path(value).name
    return re.sub(r"[^0-9A-Za-z._-]", "_", filename)[:160]


def insert_statement(table: str, row: dict) -> str:
    columns = ",".join(f'"{column}"' for column in row)
    values = ",".join(sql_literal(value) for value in row.values())
    return f'INSERT INTO "{table}"({columns}) VALUES({values});'


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("backup", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()

    with gzip.open(args.backup, "rt", encoding="utf-8") as stream:
        backup = json.load(stream)
    if backup.get("format") != "modular3d-render-postgres-backup-v1":
        raise SystemExit("Formato de respaldo no reconocido.")

    args.output.mkdir(parents=True, exist_ok=True)
    releases_dir = args.output / "releases"
    releases_dir.mkdir(exist_ok=True)
    statements = [
        "PRAGMA foreign_keys=OFF;",
        "BEGIN TRANSACTION;",
        "DELETE FROM license_devices;",
        "DELETE FROM license_audit_logs;",
        "DELETE FROM license_releases;",
        "DELETE FROM license_users;",
    ]
    mapping = {
        "users": "license_users",
        "devices": "license_devices",
        "audit_logs": "license_audit_logs",
    }
    manifest = {"source_created_at": backup.get("created_at"), "tables": {}, "releases": []}

    for source_table, target_table in mapping.items():
        rows = backup["tables"][source_table]["rows"]
        for source_row in rows:
            row = {key: decode(value) for key, value in source_row.items()}
            statements.append(insert_statement(target_table, row))
        manifest["tables"][target_table] = len(rows)

    release_rows = backup["tables"]["releases"]["rows"]
    for source_row in release_rows:
        row = {key: decode(value) for key, value in source_row.items()}
        data = row.pop("file_data")
        filename = clean_filename(row["filename"])
        destination = releases_dir / filename
        destination.write_bytes(data)
        row["r2_key"] = f"license-releases/{filename}"
        statements.append(insert_statement("license_releases", row))
        manifest["releases"].append({
            "filename": filename,
            "r2_key": row["r2_key"],
            "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
        })
    manifest["tables"]["license_releases"] = len(release_rows)

    statements.extend(["COMMIT;", "PRAGMA foreign_keys=ON;"])
    (args.output / "import-d1.sql").write_text("\n".join(statements) + "\n", encoding="utf-8")
    (args.output / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(manifest, ensure_ascii=False))


if __name__ == "__main__":
    main()
