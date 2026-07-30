import json
import re
from datetime import datetime
from typing import Any, Awaitable, Callable

import json_repair


SEMANTIC_STATUSES = {"supported", "weakly_supported", "unsupported", "needs_human_review"}
ALLOWED_REMEDIATION_ACTIONS = {"rewrite_only", "search_and_rewrite", "risk_only"}
ALLOWED_REMEDIATION_TOOLS = {
    "rewrite_only": "semantic_rewrite_section",
    "search_and_rewrite": "semantic_repair_search",
    "risk_only": "semantic_risk_annotation",
}
RISK_KEYWORDS = (
    "价格", "会员", "收费", "免费", "商业", "商业化", "收入", "广告", "订阅",
    "更新", "上线", "发布", "近期", "趋势", "建议", "机会", "优势", "更适合",
)


def _norm(text: str) -> str:
    return re.sub(r"\s+", "", text or "").lower()


def _tokenize(text: str) -> set[str]:
    tokens = set(re.findall(r"[\w\u4e00-\u9fff]{2,}", text or ""))
    compact = _norm(text)
    if compact:
        tokens.add(compact[:24])
    return tokens


def _matching_evidence(summary: str, evidence_ledger: list[dict[str, Any]]) -> list[dict[str, Any]]:
    summary_tokens = _tokenize(summary)
    if not summary_tokens:
        return []
    matches = []
    for item in evidence_ledger or []:
        claim = str(item.get("claim") or "")
        source = str(item.get("source_url") or "")
        haystack = _tokenize(f"{claim} {source}")
        if summary_tokens & haystack or _norm(claim) in _norm(summary) or _norm(summary) in _norm(claim):
            matches.append(item)
    return matches


def _status_for_support(summary: str, evidence: list[dict[str, Any]], inline_evidence: list[dict[str, Any]] | None = None) -> str:
    if "暂未" in summary or "未找到" in summary:
        return "needs_human_review"
    if evidence:
        return "supported"
    if inline_evidence:
        return "weakly_supported"
    return "unsupported"


def _severity_for_text(text: str) -> str:
    return "high" if any(keyword in text for keyword in RISK_KEYWORDS) or re.search(r"\d", text or "") else "medium"


def _report_claim_candidates(report: str, limit: int = 12) -> list[dict[str, str]]:
    claims = []
    current_section = ""
    for raw_line in (report or "").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        heading = re.match(r"^\s*#{1,6}\s*(.+)$", line)
        if heading:
            current_section = heading.group(1).strip()
            continue
        if line.startswith("|") or len(line) < 10:
            continue
        sentences = re.split(r"(?<=[。！？!?])\s*", line)
        for sentence in sentences:
            sentence = sentence.strip("- 　\t")
            if len(sentence) < 10:
                continue
            if any(keyword in sentence for keyword in RISK_KEYWORDS) or re.search(r"\d", sentence):
                claims.append({"section": current_section, "claim": sentence[:280]})
            if len(claims) >= limit:
                return claims
    return claims


def _gap(
    gap_id: str,
    gap_type: str,
    claim: str,
    severity: str,
    matching_evidence_count: int,
    location: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "id": gap_id,
        "type": gap_type,
        "claim": claim,
        "severity": severity,
        "matching_evidence_count": matching_evidence_count,
        "location": location or {},
    }


def build_semantic_validation(
    report: str,
    matrix: dict[str, Any],
    evidence_ledger: list[dict[str, Any]],
    llm_result: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if llm_result:
        return _normalize_semantic_validation(llm_result)

    matrix_validation = []
    claim_validation = []
    semantic_gaps = []

    gap_index = 1
    for row in matrix.get("rows") or []:
        competitor = row.get("competitor") or ""
        for dimension, cell in (row.get("cells") or {}).items():
            summary = str(cell.get("summary") or "")
            inline_evidence = cell.get("evidence") or []
            evidence = [
                item for item in _matching_evidence(summary, evidence_ledger)
                if (not competitor or item.get("competitor") == competitor)
                and (not dimension or item.get("dimension") == dimension)
            ]
            status = _status_for_support(summary, evidence, inline_evidence)
            result = {
                "competitor": competitor,
                "dimension": dimension,
                "summary": summary,
                "status": status,
                "reason": "矩阵摘要找到匹配证据" if evidence else "未找到能支撑该矩阵摘要的结构化证据",
                "matching_evidence_count": len(evidence),
            }
            matrix_validation.append(result)
            if status in {"unsupported", "needs_human_review"}:
                semantic_gaps.append(_gap(
                    f"semantic_gap_{gap_index}",
                    "matrix_unsupported",
                    summary,
                    _severity_for_text(f"{dimension} {summary}"),
                    len(evidence),
                    {"competitor": competitor, "dimension": dimension},
                ))
                gap_index += 1

    for item in _report_claim_candidates(report):
        claim = item["claim"]
        evidence = _matching_evidence(claim, evidence_ledger)
        status = _status_for_support(claim, evidence, [{"snippet": claim}] if "http" in claim else [])
        result = {
            "section": item["section"],
            "claim": claim,
            "status": status,
            "reason": "正文 claim 找到匹配证据" if evidence else "未找到能支撑该正文 claim 的结构化证据",
            "matching_evidence_count": len(evidence),
        }
        claim_validation.append(result)
        if status in {"unsupported", "needs_human_review"}:
            semantic_gaps.append(_gap(
                f"semantic_gap_{gap_index}",
                "claim_unsupported",
                claim,
                _severity_for_text(claim),
                len(evidence),
                {"section": item["section"]},
            ))
            gap_index += 1

    return {
        "generated_at": datetime.now().isoformat(),
        "mode": "heuristic_fallback",
        "statuses": sorted(SEMANTIC_STATUSES),
        "matrix_validation": matrix_validation,
        "claim_validation": claim_validation,
        "semantic_gaps": semantic_gaps,
        "summary": _summarize_validation(matrix_validation, claim_validation, semantic_gaps),
    }


def _normalize_semantic_validation(payload: dict[str, Any]) -> dict[str, Any]:
    matrix_validation = [
        {**item, "status": item.get("status") if item.get("status") in SEMANTIC_STATUSES else "needs_human_review"}
        for item in payload.get("matrix_validation") or []
        if isinstance(item, dict)
    ]
    claim_validation = [
        {**item, "status": item.get("status") if item.get("status") in SEMANTIC_STATUSES else "needs_human_review"}
        for item in payload.get("claim_validation") or []
        if isinstance(item, dict)
    ]
    semantic_gaps = [item for item in payload.get("semantic_gaps") or [] if isinstance(item, dict)]
    existing_gap_keys = {
        (
            str(gap.get("type") or ""),
            str(gap.get("claim") or ""),
            str((gap.get("location") or {}).get("dimension") or ""),
            str((gap.get("location") or {}).get("section") or ""),
        )
        for gap in semantic_gaps
    }
    gap_index = len(semantic_gaps) + 1
    for item in matrix_validation:
        if item.get("status") not in {"unsupported", "needs_human_review"}:
            continue
        claim = str(item.get("summary") or item.get("claim") or "")
        location = {"competitor": item.get("competitor", ""), "dimension": item.get("dimension", "")}
        key = ("matrix_unsupported", claim, str(location["dimension"]), "")
        if key in existing_gap_keys:
            continue
        semantic_gaps.append(_gap(
            f"semantic_gap_{gap_index}",
            "matrix_unsupported",
            claim,
            _severity_for_text(f"{location['dimension']} {claim}"),
            int(item.get("matching_evidence_count") or 0),
            location,
        ))
        gap_index += 1
    for item in claim_validation:
        if item.get("status") not in {"unsupported", "needs_human_review"}:
            continue
        claim = str(item.get("claim") or "")
        location = {"section": item.get("section", "")}
        key = ("claim_unsupported", claim, "", str(location["section"]))
        if key in existing_gap_keys:
            continue
        semantic_gaps.append(_gap(
            f"semantic_gap_{gap_index}",
            "claim_unsupported",
            claim,
            _severity_for_text(claim),
            int(item.get("matching_evidence_count") or 0),
            location,
        ))
        gap_index += 1
    return {
        "generated_at": datetime.now().isoformat(),
        "mode": "llm",
        "statuses": sorted(SEMANTIC_STATUSES),
        "matrix_validation": matrix_validation,
        "claim_validation": claim_validation,
        "semantic_gaps": semantic_gaps,
        "summary": _summarize_validation(matrix_validation, claim_validation, semantic_gaps),
    }


def _summarize_validation(
    matrix_validation: list[dict[str, Any]],
    claim_validation: list[dict[str, Any]],
    semantic_gaps: list[dict[str, Any]],
) -> dict[str, int]:
    all_items = [*matrix_validation, *claim_validation]
    return {
        "checked_items": len(all_items),
        "supported": sum(1 for item in all_items if item.get("status") == "supported"),
        "weakly_supported": sum(1 for item in all_items if item.get("status") == "weakly_supported"),
        "unsupported": sum(1 for item in all_items if item.get("status") == "unsupported"),
        "needs_human_review": sum(1 for item in all_items if item.get("status") == "needs_human_review"),
        "semantic_gap_count": len(semantic_gaps),
    }


def build_semantic_validator_prompt(report: str, matrix: dict[str, Any], evidence_ledger: list[dict[str, Any]]) -> str:
    return f"""你是竞品研究报告的 Semantic Validator。你不是自由工具调用 Agent。
请同时检查竞品矩阵和报告正文关键 claim 是否被证据支撑。
只返回 JSON，不要输出解释性正文。

状态只能使用：supported、weakly_supported、unsupported、needs_human_review。
补救建议只能使用：rewrite_only、search_and_rewrite、risk_only。

竞品矩阵 JSON：
{json.dumps(matrix, ensure_ascii=False)[:6000]}

证据台账 JSON：
{json.dumps(evidence_ledger[:50], ensure_ascii=False)[:8000]}

报告正文：
{report[:12000]}

返回格式：
{{
  "matrix_validation": [],
  "claim_validation": [],
  "semantic_gaps": []
}}
"""


async def run_semantic_validator(
    report: str,
    matrix: dict[str, Any],
    evidence_ledger: list[dict[str, Any]],
    llm_call: Callable[[str], Awaitable[str]] | None = None,
) -> dict[str, Any]:
    if llm_call:
        try:
            raw = await llm_call(build_semantic_validator_prompt(report, matrix, evidence_ledger))
            parsed = json_repair.loads(raw)
            if isinstance(parsed, dict):
                return build_semantic_validation(report, matrix, evidence_ledger, parsed)
        except Exception:
            pass
    return build_semantic_validation(report, matrix, evidence_ledger)


def plan_remediation_actions(validation: dict[str, Any], max_actions: int = 3) -> list[dict[str, Any]]:
    actions = []
    for gap in validation.get("semantic_gaps") or []:
        if len(actions) >= max_actions:
            break
        severity = gap.get("severity", "medium")
        evidence_count = int(gap.get("matching_evidence_count") or 0)
        if severity == "low":
            action = "risk_only"
        elif evidence_count > 0:
            action = "rewrite_only"
        else:
            action = "search_and_rewrite"
        if action not in ALLOWED_REMEDIATION_ACTIONS:
            action = "risk_only"
        actions.append({
            "id": f"remediation_{len(actions) + 1}",
            "gap_id": gap.get("id"),
            "action": action,
            "tool": ALLOWED_REMEDIATION_TOOLS[action],
            "claim": gap.get("claim", ""),
            "location": gap.get("location") or {},
            "severity": severity,
        })
    return actions
