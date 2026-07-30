from backend.server.progress_events import make_progress_event, normalize_progress_event


def test_make_progress_event_keeps_chinese_message_and_raw_detail():
    event = make_progress_event(
        content="semantic_validation",
        message_zh="正在校验报告语义支撑",
        raw_message="Running semantic validator",
        stage="semantic_validation",
        status="running",
        severity="info",
    )

    assert event["type"] == "logs"
    assert event["output"] == "正在校验报告语义支撑"
    assert event["metadata"]["message_zh"] == "正在校验报告语义支撑"
    assert event["metadata"]["raw_message"] == "Running semantic validator"


def test_normalize_progress_event_translates_known_english_logs():
    event = normalize_progress_event(
        {
            "type": "logs",
            "content": "agent_evaluation",
            "output": "Agent Evaluator found 2 priority gap(s).",
        }
    )

    assert event["output"] == "材料门控发现 2 个优先缺口"
    assert event["metadata"]["stage"] == "evidence_gate"
    assert event["metadata"]["raw_message"] == "Agent Evaluator found 2 priority gap(s)."


def test_normalize_progress_event_marks_errors_visibly():
    event = normalize_progress_event(
        {
            "type": "logs",
            "content": "error",
            "output": "Error: model timeout",
        }
    )

    assert event["metadata"]["severity"] == "error"
    assert event["metadata"]["status"] == "failed"
    assert "失败" in event["output"]


def test_normalize_progress_event_accepts_non_dict_metadata():
    event = normalize_progress_event(
        {
            "type": "logs",
            "content": "subqueries",
            "output": "queries",
            "metadata": ["query one", "query two"],
        }
    )

    assert event["metadata"] == ["query one", "query two"]
    assert event["progress_metadata"]["raw_metadata"] == ["query one", "query two"]
    assert event["progress_metadata"]["message_zh"] == "queries"
