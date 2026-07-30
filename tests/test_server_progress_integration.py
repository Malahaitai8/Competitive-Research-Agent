import pytest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from backend.server.server_utils import CustomLogsHandler


class FakeWebSocket:
    def __init__(self):
        self.messages = []

    async def send_json(self, data):
        self.messages.append(data)


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_custom_logs_handler_normalizes_log_events(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    websocket = FakeWebSocket()
    handler = CustomLogsHandler(websocket, "progress test")

    await handler.send_json({
        "type": "logs",
        "content": "agent_evaluation",
        "output": "Agent Evaluator found 3 priority gap(s).",
    })

    assert websocket.messages[0]["output"] == "材料门控发现 3 个优先缺口"
    assert websocket.messages[0]["metadata"]["raw_message"] == "Agent Evaluator found 3 priority gap(s)."
