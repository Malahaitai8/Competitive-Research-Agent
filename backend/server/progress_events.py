import re
from datetime import datetime
from typing import Any


KNOWN_LOG_MESSAGES = {
    "agent_evaluation": {
        "stage": "evidence_gate",
        "status": "completed",
        "severity": "info",
        "template": "材料门控发现 {count} 个优先缺口",
    },
    "agent_repair_summary": {
        "stage": "material_remediation",
        "status": "completed",
        "severity": "info",
        "message": "材料补救完成",
    },
    "semantic_validation": {
        "stage": "semantic_validation",
        "status": "running",
        "severity": "info",
        "message": "正在校验报告语义支撑",
    },
    "semantic_validation_summary": {
        "stage": "semantic_validation",
        "status": "completed",
        "severity": "info",
        "message": "语义校验完成",
    },
    "semantic_remediation_summary": {
        "stage": "semantic_remediation",
        "status": "completed",
        "severity": "info",
        "message": "语义补救完成",
    },
}


def _gap_count(output: str) -> int:
    match = re.search(r"found\s+(\d+)\s+priority gap", output or "", flags=re.I)
    return int(match.group(1)) if match else 0


def make_progress_event(
    content: str,
    message_zh: str,
    raw_message: str = "",
    stage: str = "system",
    status: str = "running",
    severity: str = "info",
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    meta = dict(metadata or {})
    meta.update({
        "stage": stage,
        "status": status,
        "severity": severity,
        "message_zh": message_zh,
        "raw_message": raw_message or message_zh,
        "normalized_at": datetime.now().isoformat(),
    })
    return {
        "type": "logs",
        "content": content,
        "output": message_zh,
        "metadata": meta,
    }


def normalize_progress_event(data: dict[str, Any]) -> dict[str, Any]:
    if data.get("type") != "logs":
        return data

    normalized = dict(data)
    content = str(normalized.get("content") or "")
    output = str(normalized.get("output") or "")
    raw_metadata = normalized.get("metadata")
    metadata = dict(raw_metadata) if isinstance(raw_metadata, dict) else {}
    metadata_target = "metadata" if isinstance(raw_metadata, dict) or raw_metadata is None else "progress_metadata"
    if raw_metadata is not None and not isinstance(raw_metadata, dict):
        metadata["raw_metadata"] = raw_metadata
    raw_message = metadata.get("raw_message") or output

    if content == "error" or output.lower().startswith("error:"):
        message_zh = metadata.get("message_zh") or f"任务执行失败：{output[6:].strip() if output.lower().startswith('error:') else output}"
        metadata.update({
            "stage": metadata.get("stage", "system"),
            "status": "failed",
            "severity": "error",
            "message_zh": message_zh,
            "raw_message": raw_message,
        })
        normalized["output"] = message_zh
        normalized[metadata_target] = metadata
        return normalized

    if output == "Task already running. Please wait.":
        metadata.update({
            "stage": "task_control",
            "status": "blocked",
            "severity": "warning",
            "message_zh": "任务正在运行中，请稍后再试",
            "raw_message": raw_message,
        })
        normalized["output"] = metadata["message_zh"]
        normalized[metadata_target] = metadata
        return normalized

    known = KNOWN_LOG_MESSAGES.get(content)
    if known:
        message_zh = known.get("message") or known["template"].format(count=_gap_count(output))
        metadata.update({
            "stage": metadata.get("stage", known["stage"]),
            "status": metadata.get("status", known["status"]),
            "severity": metadata.get("severity", known["severity"]),
            "message_zh": metadata.get("message_zh", message_zh),
            "raw_message": raw_message,
        })
        normalized["output"] = metadata["message_zh"]
        normalized[metadata_target] = metadata
        return normalized

    metadata.setdefault("raw_message", raw_message)
    metadata.setdefault("message_zh", output)
    metadata.setdefault("stage", "research")
    metadata.setdefault("status", "running")
    metadata.setdefault("severity", "info")
    normalized[metadata_target] = metadata
    return normalized
