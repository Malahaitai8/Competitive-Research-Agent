import asyncio
import json
import os
from pathlib import Path
from typing import Any, Dict, List


class ReportStore:
    def __init__(self, path: Path):
        self._path = path
        self._lock = asyncio.Lock()
        self._database_url = os.getenv("DATABASE_URL", "").strip()
        self._engine = None
        if self._database_url:
            self._engine = self._create_engine(self._database_url)
            self._ensure_sql_table()

    def _create_engine(self, database_url: str):
        from sqlalchemy import create_engine

        connect_args = {}
        if database_url.startswith("mysql"):
            connect_args = {"charset": "utf8mb4"}
        return create_engine(database_url, pool_pre_ping=True, connect_args=connect_args)

    def _ensure_sql_table(self) -> None:
        from sqlalchemy import text

        create_table_sql = """
        CREATE TABLE IF NOT EXISTS research_reports (
            id VARCHAR(128) PRIMARY KEY,
            question TEXT NULL,
            answer LONGTEXT NULL,
            ordered_data LONGTEXT NULL,
            chat_messages LONGTEXT NULL,
            links LONGTEXT NULL,
            metadata LONGTEXT NULL,
            timestamp BIGINT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
        """
        with self._engine.begin() as conn:
            conn.execute(text(create_table_sql))

    def _json_dumps(self, value: Any) -> str:
        return json.dumps(value if value is not None else [], ensure_ascii=False)

    def _json_loads(self, value: Any, default: Any) -> Any:
        if not value:
            return default
        try:
            return json.loads(value)
        except Exception:
            return default

    async def _ensure_parent_dir(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)

    async def _read_all_unlocked(self) -> Dict[str, Dict[str, Any]]:
        if not self._path.exists():
            return {}
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data  # type: ignore[return-value]
        except Exception:
            return {}
        return {}

    async def _write_all_unlocked(self, data: Dict[str, Dict[str, Any]]) -> None:
        await self._ensure_parent_dir()
        tmp_path = self._path.with_suffix(self._path.suffix + ".tmp")
        tmp_path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        tmp_path.replace(self._path)

    def _row_to_report(self, row: Any) -> Dict[str, Any]:
        data = row._mapping
        return {
            "id": data["id"],
            "question": data["question"],
            "answer": data["answer"] or "",
            "orderedData": self._json_loads(data["ordered_data"], []),
            "chatMessages": self._json_loads(data["chat_messages"], []),
            "links": self._json_loads(data["links"], {}),
            "metadata": self._json_loads(data["metadata"], {}),
            "timestamp": data["timestamp"],
        }

    async def _list_reports_sql(self, report_ids: List[str] | None = None) -> List[Dict[str, Any]]:
        from sqlalchemy import bindparam, text

        def query_reports() -> List[Dict[str, Any]]:
            with self._engine.begin() as conn:
                if report_ids:
                    stmt = (
                        text("SELECT * FROM research_reports WHERE id IN :ids ORDER BY timestamp DESC")
                        .bindparams(bindparam("ids", expanding=True))
                    )
                    rows = conn.execute(stmt, {"ids": report_ids}).fetchall()
                else:
                    rows = conn.execute(
                        text("SELECT * FROM research_reports ORDER BY timestamp DESC LIMIT 100")
                    ).fetchall()
                return [self._row_to_report(row) for row in rows]

        return await asyncio.to_thread(query_reports)

    async def _get_report_sql(self, report_id: str) -> Dict[str, Any] | None:
        from sqlalchemy import text

        def query_report() -> Dict[str, Any] | None:
            with self._engine.begin() as conn:
                row = conn.execute(
                    text("SELECT * FROM research_reports WHERE id = :id"),
                    {"id": report_id},
                ).fetchone()
                return self._row_to_report(row) if row else None

        return await asyncio.to_thread(query_report)

    async def _upsert_report_sql(self, report_id: str, report: Dict[str, Any]) -> None:
        from sqlalchemy import text

        payload = {
            "id": report_id,
            "question": report.get("question"),
            "answer": report.get("answer") or "",
            "ordered_data": self._json_dumps(report.get("orderedData") or []),
            "chat_messages": self._json_dumps(report.get("chatMessages") or []),
            "links": self._json_dumps(report.get("links") or {}),
            "metadata": self._json_dumps(report.get("metadata") or {}),
            "timestamp": int(report.get("timestamp") or 0),
        }
        stmt = text(
            """
            INSERT INTO research_reports
                (id, question, answer, ordered_data, chat_messages, links, metadata, timestamp)
            VALUES
                (:id, :question, :answer, :ordered_data, :chat_messages, :links, :metadata, :timestamp)
            ON DUPLICATE KEY UPDATE
                question = VALUES(question),
                answer = VALUES(answer),
                ordered_data = VALUES(ordered_data),
                chat_messages = VALUES(chat_messages),
                links = VALUES(links),
                metadata = VALUES(metadata),
                timestamp = VALUES(timestamp)
            """
        )

        def upsert() -> None:
            with self._engine.begin() as conn:
                conn.execute(stmt, payload)

        await asyncio.to_thread(upsert)

    async def _delete_report_sql(self, report_id: str) -> bool:
        from sqlalchemy import text

        def delete() -> bool:
            with self._engine.begin() as conn:
                result = conn.execute(
                    text("DELETE FROM research_reports WHERE id = :id"),
                    {"id": report_id},
                )
                return bool(result.rowcount)

        return await asyncio.to_thread(delete)

    async def list_reports(self, report_ids: List[str] | None = None) -> List[Dict[str, Any]]:
        if self._engine is not None:
            return await self._list_reports_sql(report_ids)

        async with self._lock:
            data = await self._read_all_unlocked()
            reports = list(data.values()) if report_ids is None else [
                data[report_id] for report_id in report_ids if report_id in data
            ]
            return sorted(reports, key=lambda item: item.get("timestamp") or 0, reverse=True)

    async def get_report(self, report_id: str) -> Dict[str, Any] | None:
        if self._engine is not None:
            return await self._get_report_sql(report_id)

        async with self._lock:
            data = await self._read_all_unlocked()
            return data.get(report_id)

    async def upsert_report(self, report_id: str, report: Dict[str, Any]) -> None:
        if self._engine is not None:
            await self._upsert_report_sql(report_id, report)
            return

        async with self._lock:
            data = await self._read_all_unlocked()
            data[report_id] = report
            await self._write_all_unlocked(data)

    async def delete_report(self, report_id: str) -> bool:
        if self._engine is not None:
            return await self._delete_report_sql(report_id)

        async with self._lock:
            data = await self._read_all_unlocked()
            existed = report_id in data
            if existed:
                del data[report_id]
                await self._write_all_unlocked(data)
            return existed
