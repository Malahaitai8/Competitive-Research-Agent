import asyncio
import hashlib
import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Awaitable, Callable


TaskRunner = Callable[["ResearchTaskEventSink"], Awaitable[dict[str, Any] | None]]


@dataclass
class ResearchTaskRecord:
    task_id: str
    request: dict[str, Any]
    title: str
    status: str = "running"
    current_stage: str = "plan"
    events: list[dict[str, Any]] = field(default_factory=list)
    subscribers: set[Any] = field(default_factory=set)
    background_task: asyncio.Task | None = None
    result: dict[str, Any] | None = None
    error: str = ""
    created_at: str = field(default_factory=lambda: datetime.now().isoformat())
    updated_at: str = field(default_factory=lambda: datetime.now().isoformat())


class ResearchTaskEventSink:
    def __init__(self, registry: "ResearchTaskRegistry", task_id: str):
        self.registry = registry
        self.task_id = task_id

    async def send_json(self, data: dict[str, Any]) -> None:
        await self.registry.publish(self.task_id, data)


class ResearchTaskRegistry:
    def __init__(self, max_events: int = 2000):
        self.max_events = max(1, int(max_events))
        self.tasks: dict[str, ResearchTaskRecord] = {}

    def get(self, task_id: str) -> ResearchTaskRecord | None:
        return self.tasks.get(task_id)

    @staticmethod
    def _title_from_request(request: dict[str, Any]) -> str:
        competitive = request.get("competitive_research") or {}
        return str(
            competitive.get("research_topic")
            or request.get("title")
            or request.get("task")
            or "未命名调研"
        ).strip()

    @staticmethod
    def _new_task_id(request: dict[str, Any]) -> str:
        timestamp_ms = int(time.time() * 1000)
        digest = hashlib.md5(
            f"{timestamp_ms}:{request.get('task', '')}".encode("utf-8", errors="ignore")
        ).hexdigest()[:10]
        return f"task_{timestamp_ms}_{digest}"

    async def create_task(
        self,
        request: dict[str, Any],
        runner: TaskRunner,
        websocket: Any | None = None,
    ) -> str:
        task_id = self._new_task_id(request)
        record = ResearchTaskRecord(
            task_id=task_id,
            request=dict(request),
            title=self._title_from_request(request),
        )
        self.tasks[task_id] = record
        if websocket is not None:
            record.subscribers.add(websocket)
            await websocket.send_json({
                "type": "task_accepted",
                "task_id": task_id,
                "status": record.status,
                "current_stage": record.current_stage,
                "title": record.title,
                "created_at": record.created_at,
            })
        sink = ResearchTaskEventSink(self, task_id)
        record.background_task = asyncio.create_task(self._run(record, runner, sink))
        return task_id

    async def _run(
        self,
        record: ResearchTaskRecord,
        runner: TaskRunner,
        sink: ResearchTaskEventSink,
    ) -> None:
        try:
            result = await runner(sink)
            if result is not None:
                record.result = result
            if record.status not in {"complete", "failed"}:
                record.status = "complete"
                record.updated_at = datetime.now().isoformat()
                await self._broadcast(record, self._snapshot(record))
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            record.status = "failed"
            record.error = str(exc)
            record.updated_at = datetime.now().isoformat()
            error_event = {
                "type": "logs",
                "content": "error",
                "output": f"研究任务执行失败：{exc}",
                "metadata": {
                    "stage": "system",
                    "status": "failed",
                    "severity": "error",
                    "message_zh": f"研究任务执行失败：{exc}",
                    "raw_message": f"Error: {exc}",
                },
            }
            await self.publish(record.task_id, error_event)
            await self._broadcast(record, self._snapshot(record))

    async def publish(self, task_id: str, data: dict[str, Any]) -> None:
        record = self.tasks.get(task_id)
        if record is None:
            return

        event = dict(data)
        record.events.append(event)
        if len(record.events) > self.max_events:
            record.events[:] = record.events[-self.max_events:]

        metadata = event.get("metadata") if isinstance(event.get("metadata"), dict) else {}
        stage = metadata.get("stage")
        if stage:
            record.current_stage = str(stage)

        if event.get("type") == "path":
            record.result = event.get("output") if isinstance(event.get("output"), dict) else {}
            record.status = "complete"
        elif event.get("type") == "logs" and (
            event.get("content") == "error" or metadata.get("status") == "failed"
        ):
            record.status = "failed"
            record.error = str(metadata.get("message_zh") or event.get("output") or "")

        record.updated_at = datetime.now().isoformat()
        await self._broadcast(record, event)

    def unsubscribe(self, websocket: Any) -> None:
        for record in self.tasks.values():
            record.subscribers.discard(websocket)

    async def subscribe(self, task_id: str, websocket: Any) -> bool:
        record = self.tasks.get(task_id)
        if record is None:
            await websocket.send_json({
                "type": "task_not_found",
                "task_id": task_id,
            })
            return False

        record.subscribers.add(websocket)
        await websocket.send_json(self._snapshot(record))
        for event in record.events:
            await websocket.send_json(event)
        return True

    @staticmethod
    def _snapshot(record: ResearchTaskRecord) -> dict[str, Any]:
        return {
            "type": "task_snapshot",
            "task_id": record.task_id,
            "title": record.title,
            "status": record.status,
            "current_stage": record.current_stage,
            "created_at": record.created_at,
            "updated_at": record.updated_at,
            "event_count": len(record.events),
            "result": record.result,
            "error": record.error,
        }

    async def _broadcast(
        self,
        record: ResearchTaskRecord,
        data: dict[str, Any],
    ) -> None:
        disconnected = []
        for websocket in tuple(record.subscribers):
            try:
                await websocket.send_json(data)
            except Exception:
                disconnected.append(websocket)
        for websocket in disconnected:
            record.subscribers.discard(websocket)
