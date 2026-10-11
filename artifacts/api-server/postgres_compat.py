"""Small DB-API adapter for the Flask domain SQL shared with SQLite tests.

PostgreSQL schema changes are applied explicitly by the development migration
tool; this module never creates or migrates tables at application startup.
"""
from __future__ import annotations

import re
from typing import Any

import psycopg
from psycopg.rows import dict_row


class HybridRow(dict):
    """Mapping access for named columns and SQLite-compatible numeric indexes."""

    def __getitem__(self, key: Any) -> Any:
        if isinstance(key, int):
            return tuple(self.values())[key]
        return super().__getitem__(key)


class Cursor:
    def __init__(self, cursor: Any):
        self._cursor = cursor
        self.rowcount = cursor.rowcount

    @staticmethod
    def _row(value: dict[str, Any] | None) -> HybridRow | None:
        return HybridRow(value) if value is not None else None

    def fetchone(self) -> HybridRow | None:
        return self._row(self._cursor.fetchone())

    def fetchall(self) -> list[HybridRow]:
        return [HybridRow(row) for row in self._cursor.fetchall()]


class Connection:
    def __init__(self, dsn: str, schema: str):
        if not re.fullmatch(r"[a-zA-Z_][a-zA-Z0-9_]*", schema):
            raise ValueError("DATABASE_SCHEMA must be a simple PostgreSQL schema name.")
        self._connection = psycopg.connect(
            dsn,
            row_factory=dict_row,
            options=f"-c search_path={schema}",
        )

    def execute(self, statement: str, parameters: tuple | list = ()) -> Cursor:
        sql = statement.strip()
        ignore_conflict = bool(re.match(r"INSERT\s+OR\s+IGNORE\b", sql, re.IGNORECASE))
        if ignore_conflict:
            sql = re.sub(r"^INSERT\s+OR\s+IGNORE\b", "INSERT", sql, flags=re.IGNORECASE)
            sql = sql.rstrip().removesuffix(";") + " ON CONFLICT DO NOTHING"
        sql = re.sub(
            r"\b([a-zA-Z_][a-zA-Z0-9_]*)\s+COLLATE\s+NOCASE\b",
            r"LOWER(\1)",
            sql,
            flags=re.IGNORECASE,
        )
        sql = sql.replace("BEGIN IMMEDIATE", "BEGIN")
        sql = sql.replace("?", "%s")
        return Cursor(self._connection.execute(sql, parameters))

    def commit(self) -> None:
        self._connection.commit()

    def rollback(self) -> None:
        self._connection.rollback()

    def close(self) -> None:
        self._connection.close()
