import asyncio
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from backend.server.research_task_registry import ResearchTaskRegistry
from backend.server import server_utils


class FakeWebSocket:
    def __init__(self, incoming):
        self.incoming = list(incoming)
        self.messages = []

    async def receive_text(self):
        if self.incoming:
            return self.incoming.pop(0)
        raise RuntimeError("browser disconnected")

    async def send_json(self, data):
        self.messages.append(data)

    async def send_text(self, data):
        self.messages.append(data)


class FakeManager:
    def __init__(self):
        self.research_tasks = ResearchTaskRegistry()


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_start_command_runs_in_registry_after_browser_disconnect(monkeypatch):
    manager = FakeManager()
    websocket = FakeWebSocket([
        "start " + json.dumps({
            "task": "刷新恢复调研",
            "report_type": "research_report",
            "competitive_research": {"research_topic": "刷新恢复调研"},
        }, ensure_ascii=False)
    ])
    research_started = asyncio.Event()
    allow_completion = asyncio.Event()

    async def fake_handle_start_command(sink, data, passed_manager):
        assert passed_manager is manager
        research_started.set()
        await sink.send_json({
            "type": "logs",
            "content": "planning_research",
            "output": "Planning",
            "metadata": {"stage": "plan", "status": "in_progress"},
        })
        await allow_completion.wait()
        paths = {"md": "outputs/recovered.md"}
        await sink.send_json({"type": "path", "output": paths})
        return paths

    monkeypatch.setattr(server_utils, "handle_start_command", fake_handle_start_command)

    await server_utils.handle_websocket_communication(websocket, manager)
    await asyncio.wait_for(research_started.wait(), timeout=1)

    accepted = next(message for message in websocket.messages if message.get("type") == "task_accepted")
    record = manager.research_tasks.get(accepted["task_id"])
    assert record is not None
    assert not record.background_task.done()
    assert not record.background_task.cancelled()

    allow_completion.set()
    await asyncio.wait_for(record.background_task, timeout=1)
    assert record.status == "complete"


@pytest.mark.anyio
async def test_subscribe_command_restores_existing_task(monkeypatch):
    manager = FakeManager()
    original_socket = FakeWebSocket([])
    allow_completion = asyncio.Event()

    async def run_research(sink):
        await sink.send_json({
            "type": "logs",
            "content": "agent_evaluation",
            "output": "Evidence gate",
            "metadata": {"stage": "evidence_gate", "status": "in_progress"},
        })
        await allow_completion.wait()
        return {}

    task_id = await manager.research_tasks.create_task(
        {"task": "已存在任务"},
        run_research,
        original_socket,
    )
    await asyncio.sleep(0)
    manager.research_tasks.unsubscribe(original_socket)

    resumed_socket = FakeWebSocket([
        "subscribe " + json.dumps({"task_id": task_id})
    ])
    await server_utils.handle_websocket_communication(resumed_socket, manager)

    assert resumed_socket.messages[0]["type"] == "task_snapshot"
    assert resumed_socket.messages[0]["task_id"] == task_id
    assert any(message.get("content") == "agent_evaluation" for message in resumed_socket.messages)

    allow_completion.set()
    await asyncio.wait_for(manager.research_tasks.get(task_id).background_task, timeout=1)
