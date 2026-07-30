import os

from gpt_researcher.utils.network import sanitize_proxy_environment


def test_sanitize_proxy_environment_removes_dead_loopback_proxy(monkeypatch):
    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:9")
    monkeypatch.setenv("HTTPS_PROXY", "http://localhost:9")
    monkeypatch.setenv("ALL_PROXY", "http://127.0.0.1:7890")

    removed = sanitize_proxy_environment()

    assert removed == {
        "HTTP_PROXY": "http://127.0.0.1:9",
        "HTTPS_PROXY": "http://localhost:9",
    }
    assert "HTTP_PROXY" not in os.environ
    assert "HTTPS_PROXY" not in os.environ
    assert os.environ["ALL_PROXY"] == "http://127.0.0.1:7890"
