import asyncio

import pytest

from backend.server.research_task_registry import ResearchTaskRegistry


class FakeWebSocket:
    def __init__(self):
        self.messages = []

    async def send_json(self, data):
        self.messages.append(data)


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_disconnecting_subscriber_does_not_cancel_background_research():
    registry = ResearchTaskRegistry()
    first_socket = FakeWebSocket()
    research_started = asyncio.Event()
    allow_completion = asyncio.Event()

    async def run_research(sink):
        await sink.send_json({
            "type": "logs",
            "content": "planning_research",
            "output": "Planning",
            "metadata": {"stage": "plan", "status": "in_progress"},
        })
        research_started.set()
        await allow_completion.wait()
        result = {"md": "outputs/report.md"}
        await sink.send_json({"type": "path", "output": result})
        return result

    task_id = await registry.create_task(
        {"task": "可恢复调研", "competitive_research": {"research_topic": "可恢复调研"}},
        run_research,
        first_socket,
    )
    await asyncio.wait_for(research_started.wait(), timeout=1)

    registry.unsubscribe(first_socket)
    record = registry.get(task_id)
    assert record is not None
    assert record.background_task is not None
    assert not record.background_task.cancelled()
    assert not record.background_task.done()

    allow_completion.set()
    await asyncio.wait_for(record.background_task, timeout=1)
    assert record.status == "complete"
    assert record.result == {"md": "outputs/report.md"}


@pytest.mark.anyio
async def test_subscribe_replays_snapshot_and_buffered_events_then_receives_completion():
    registry = ResearchTaskRegistry()
    first_socket = FakeWebSocket()
    allow_completion = asyncio.Event()

    async def run_research(sink):
        await sink.send_json({
            "type": "logs",
            "content": "agent_evaluation",
            "output": "Evidence gate",
            "metadata": {"stage": "evidence_gate", "status": "in_progress"},
        })
        await allow_completion.wait()
        result = {"md": "outputs/report.md", "competitive_analysis": "outputs/analysis.json"}
        await sink.send_json({"type": "path", "output": result})
        return result

    task_id = await registry.create_task(
        {"task": "报告恢复", "competitive_research": {"research_topic": "报告恢复"}},
        run_research,
        first_socket,
    )
    await asyncio.sleep(0)
    registry.unsubscribe(first_socket)

    resumed_socket = FakeWebSocket()
    subscribed = await registry.subscribe(task_id, resumed_socket)

    assert subscribed is True
    assert resumed_socket.messages[0]["type"] == "task_snapshot"
    assert resumed_socket.messages[0]["task_id"] == task_id
    assert resumed_socket.messages[0]["status"] == "running"
    assert resumed_socket.messages[0]["current_stage"] == "evidence_gate"
    assert any(message.get("content") == "agent_evaluation" for message in resumed_socket.messages)

    allow_completion.set()
    record = registry.get(task_id)
    await asyncio.wait_for(record.background_task, timeout=1)

    assert any(message.get("type") == "path" for message in resumed_socket.messages)
    assert record.status == "complete"


@pytest.mark.anyio
async def test_unknown_task_subscription_returns_task_not_found():
    registry = ResearchTaskRegistry()
    websocket = FakeWebSocket()

    subscribed = await registry.subscribe("task_missing", websocket)

    assert subscribed is False
    assert websocket.messages == [{
        "type": "task_not_found",
        "task_id": "task_missing",
    }]


@pytest.mark.anyio
async def test_completed_task_snapshot_contains_result_without_rerunning():
    registry = ResearchTaskRegistry()
    websocket = FakeWebSocket()
    run_count = 0

    async def run_research(sink):
        nonlocal run_count
        run_count += 1
        result = {"md": "outputs/final.md"}
        await sink.send_json({"type": "path", "output": result})
        return result

    task_id = await registry.create_task({"task": "完成任务"}, run_research, websocket)
    record = registry.get(task_id)
    await asyncio.wait_for(record.background_task, timeout=1)

    resumed_socket = FakeWebSocket()
    await registry.subscribe(task_id, resumed_socket)

    assert run_count == 1
    assert resumed_socket.messages[0]["status"] == "complete"
    assert resumed_socket.messages[0]["result"] == {"md": "outputs/final.md"}
