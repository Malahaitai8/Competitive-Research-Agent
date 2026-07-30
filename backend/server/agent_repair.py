import json
import os
import re
from datetime import datetime, timedelta
from typing import Any

import json_repair

from gpt_researcher.actions.utils import stream_output
from gpt_researcher.competitive_sources import (
    build_source_tier_summary,
    competitor_official_coverage,
    filter_usable_source_urls,
)
from gpt_researcher.llm_provider.generic.base import ReasoningEfforts
from gpt_researcher.utils.llm import create_chat_completion

from .competitive_research import (
    _competitor_aliases,
    _contains_alias,
    _dimension_section_hints,
    _extract_year_months,
    extract_competitive_request,
    is_competitive_research_task,
)


MAX_REPAIR_GAPS = 3
MAX_REPAIR_QUERIES = 3
MAX_EVIDENCE_ITEMS = 80
CRITICAL_DIMENSION_KEYWORDS = ("主体", "品牌", "关系", "定价", "价格", "会员", "收费", "商业", "更新", "版本", "发布", "近期")
RECENT_DIMENSION_KEYWORDS = ("更新", "版本", "发布", "近期", "动态", "上线")
OFFICIAL_CANDIDATE_TERMS = (
    "\u5b98\u7f51",
    "\u5b98\u65b9",
    "\u516c\u544a",
    "\u5e2e\u52a9\u4e2d\u5fc3",
    "\u5b9a\u4ef7",
    "\u4ef7\u683c",
    "\u66f4\u65b0\u65e5\u5fd7",
    "\u6bcd\u516c\u53f8",
    "\u4e1a\u52a1\u4ecb\u7ecd",
    "official",
    "pricing",
    "help",
    "docs",
    "support",
    "release",
    "changelog",
    "about",
)


def should_execute_evidence_repair(mode: str | None = None) -> bool:
    mode_value = (mode or os.getenv("COMPETITIVE_EVIDENCE_GATE_MODE") or "repair").strip().lower()
    return mode_value not in {"diagnose_only", "diagnose-only", "post-only", "post_only", "0-cycle", "off", "false", "0"}


def _dimension_keywords(dimension: str) -> list[str]:
    keywords = [dimension]
    if "定位" in dimension or "用户" in dimension:
        keywords.extend(["定位", "用户", "人群", "场景", "面向", "主打"])
    if "功能" in dimension:
        keywords.extend(["功能", "能力", "搜索", "生成", "插件", "模型"])
    if "会员" in dimension or "商业" in dimension or "定价" in dimension:
        keywords.extend(["会员", "定价", "价格", "收费", "免费", "订阅", "商业化"])
    if "更新" in dimension:
        keywords.extend(["更新", "发布", "上线", "新增", "近期", "版本"])
    return [keyword for keyword in keywords if keyword]


def _source_info(url: str) -> dict[str, Any]:
    if not url:
        return {"tier": "U", "is_official_like": False}
    classified = build_source_tier_summary([url]).get("classified_urls") or []
    source = classified[0] if classified else {}
    return {
        "tier": source.get("tier", "U"),
        "label": source.get("label", ""),
        "is_official_like": source.get("tier") == "S",
    }


def _time_hint(text: str) -> str:
    hints = _extract_year_months(text)
    return hints[0] if hints else ""


def _source_text(source: dict[str, Any]) -> str:
    return str(source.get("raw_content") or source.get("content") or source.get("body") or "")


def _source_url(source: dict[str, Any]) -> str:
    return str(source.get("url") or source.get("href") or source.get("source") or "")


def build_evidence_ledger(
    task: str,
    sources: list[dict[str, Any]],
    context: str,
    from_repair: bool = False,
) -> list[dict[str, Any]]:
    request = extract_competitive_request(task)
    competitors = request.get("competitors") or []
    dimensions = request.get("dimensions") or []
    ledger: list[dict[str, Any]] = []
    seen = set()

    candidate_sources = list(sources or [])
    if context:
        candidate_sources.append({"url": "", "raw_content": context, "title": "research_context"})

    for source in candidate_sources:
        text = _source_text(source)
        if not text:
            continue
        url = _source_url(source)
        source_meta = _source_info(url)
        compact_text = re.sub(r"\s+", "", text)
        for competitor in competitors:
            aliases = _competitor_aliases(competitor)
            if not _contains_alias(text, aliases):
                continue
            for dimension in dimensions:
                keywords = _dimension_keywords(dimension)
                if not any(keyword in text or keyword in compact_text for keyword in keywords):
                    continue
                claim = _extract_claim(text, aliases, keywords)
                key = (competitor, dimension, url, claim[:80])
                if not claim or key in seen:
                    continue
                seen.add(key)
                ledger.append({
                    "competitor": competitor,
                    "dimension": dimension,
                    "claim": claim[:260],
                    "source_url": url,
                    "source_tier": source_meta["tier"],
                    "source_label": source_meta.get("label", ""),
                    "is_official_like": source_meta["is_official_like"],
                    "time_hint": _time_hint(claim),
                    "confidence": "medium" if url else "low",
                    "from_repair": from_repair,
                })
                if len(ledger) >= MAX_EVIDENCE_ITEMS:
                    return ledger
    return ledger


def _extract_claim(text: str, aliases: list[str], keywords: list[str]) -> str:
    chunks = re.split(r"(?<=[。！？!?])\s+|\n+", text or "")
    for chunk in chunks:
        clean = re.sub(r"\s+", " ", chunk).strip()
        if len(clean) < 20:
            continue
        if _contains_alias(clean, aliases) and any(keyword in clean for keyword in keywords):
            return clean
    return ""


def _is_critical_dimension(dimension: str) -> bool:
    return any(keyword in dimension for keyword in CRITICAL_DIMENSION_KEYWORDS)


def _is_recent_dimension(dimension: str) -> bool:
    return any(keyword in dimension for keyword in RECENT_DIMENSION_KEYWORDS)


def _parse_year_month(value: str) -> tuple[int, int] | None:
    match = re.search(r"(20\d{2})(?:[-/.年](\d{1,2}))?", value or "")
    if not match:
        return None
    year = int(match.group(1))
    month = int(match.group(2) or 1)
    if month < 1 or month > 12:
        return None
    return year, month


def _month_index(year_month: tuple[int, int]) -> int:
    return year_month[0] * 12 + year_month[1]


def _recent_cutoff_month(time_range: str) -> int | None:
    if not time_range:
        return None
    month_match = re.search(r"(?:最近|近)\s*(\d+)\s*个?月", time_range)
    if month_match:
        months = max(int(month_match.group(1)), 1)
    elif "最近" in time_range or re.search(r"近\s*\d+\s*年", time_range):
        years = re.search(r"近\s*(\d+)\s*年", time_range)
        months = int(years.group(1)) * 12 if years else 6
    else:
        return None
    cutoff = datetime.now() - timedelta(days=30 * months)
    return _month_index((cutoff.year, cutoff.month))


def _allowed_year_range(time_range: str) -> tuple[int, int] | None:
    match = re.search(r"(20\d{2})\s*[-~—至到]\s*(20\d{2})", time_range or "")
    if match:
        return int(match.group(1)), int(match.group(2))
    year = re.search(r"(20\d{2})", time_range or "")
    if year:
        value = int(year.group(1))
        return value, value
    return None


def _is_time_scope_requested(request: dict[str, Any], dimensions: list[str]) -> bool:
    time_range = str(request.get("time_range") or "")
    return bool(time_range) and (
        "最近" in time_range
        or "近" in time_range
        or bool(_allowed_year_range(time_range))
        or any(_is_recent_dimension(dimension) for dimension in dimensions)
    )


def _time_out_of_scope(time_hint: str, request: dict[str, Any]) -> bool:
    parsed = _parse_year_month(time_hint)
    if not parsed:
        return False
    time_range = str(request.get("time_range") or "")
    cutoff = _recent_cutoff_month(time_range)
    if cutoff is not None and _month_index(parsed) < cutoff:
        return True
    allowed_years = _allowed_year_range(time_range)
    if allowed_years and not (allowed_years[0] <= parsed[0] <= allowed_years[1]):
        return True
    return False


def _gap_bucket(gap_type: str) -> str:
    hard_types = {
        "unknown_official_profile",
        "missing_official_source",
        "missing_dimension_evidence",
        "weak_critical_evidence",
        "time_scope_risk",
        "time_uncertain_evidence",
        "source_quality_risk",
    }
    return "hard_gate" if gap_type in hard_types else "soft_warning"


def _gap_target(competitor: str, dimension: str) -> str:
    competitor_value = str(competitor or "").strip()
    dimension_value = str(dimension or "").strip()
    if competitor_value and dimension_value:
        return f"{competitor_value} 的“{dimension_value}”"
    if competitor_value:
        return competitor_value
    if dimension_value:
        return f"“{dimension_value}”"
    return "这部分信息"


def _gap_user_message(gap_type: str, competitor: str, dimension: str, reason: str) -> str:
    target = _gap_target(competitor, dimension)
    messages = {
        "candidate_official_source_found": f"{target}找到了疑似官方资料，但还需要确认是否确实属于对应产品或公司。",
        "official_source_candidate_found": f"{target}找到了疑似官方资料，但还需要确认是否确实属于对应产品或公司。",
        "unknown_official_profile": f"{target}暂时缺少明确的官方主体或官网资料支撑。",
        "missing_official_source": f"{target}缺少可识别的官方来源，关键结论的可信度会受影响。",
        "weak_critical_evidence": f"{target}属于关键事实，但目前证据还不够强。",
        "critical_fact_weak": f"{target}属于关键事实，但目前证据还不够强。",
        "missing_dimension_evidence": f"{target}还没有收集到足够的结构化证据。",
        "time_scope_risk": f"{target}的时间范围可能不符合本次研究要求。",
        "time_uncertain_evidence": f"{target}缺少清晰日期，暂时无法判断是否为最新公开信息。",
        "source_quality_risk": "本次研究里低可信来源占比较高，部分结论需要谨慎使用。",
        "source_quality_warning": "本次研究里低可信来源占比偏高，建议抽样复核关键事实。",
        "low_credibility_source": f"{target}主要来自低可信来源，需要补充更可靠证据。",
        "insufficient_official_evidence": f"{target}的官方证据不足，需要优先补齐。",
        "unresolved_after_repair": f"{target}在补充检索后仍未完全确认，需要人工复核。",
        "resolved_after_repair": f"{target}已通过补充检索找到更可靠的证据。",
    }
    fallback = str(reason or "").strip()
    return messages.get(gap_type) or fallback or f"{target}需要进一步核验。"


def _gap_suggested_action(gap_type: str, competitor: str, dimension: str) -> str:
    target = _gap_target(competitor, dimension)
    actions = {
        "candidate_official_source_found": "确认候选官网、官方账号或母公司资料是否确实对应目标产品，再采用其中信息。",
        "official_source_candidate_found": "确认候选官网、官方账号或母公司资料是否确实对应目标产品，再采用其中信息。",
        "unknown_official_profile": "优先补充官网、官方公告、帮助中心、定价页或母公司业务介绍。",
        "missing_official_source": "优先补充官网、官方公告、帮助中心、定价页或母公司业务介绍。",
        "weak_critical_evidence": "用官方来源或高可信媒体交叉验证后，再把结论写入报告。",
        "critical_fact_weak": "用官方来源或高可信媒体交叉验证后，再把结论写入报告。",
        "missing_dimension_evidence": f"继续补充{target}相关资料，至少获得一条可追溯来源。",
        "time_scope_risk": "补充最近公告、更新日志或新闻稿，并核对是否落在本次时间范围内。",
        "time_uncertain_evidence": "补充带发布日期的来源，避免把旧信息当作最新情况。",
        "source_quality_risk": "优先替换为官方来源、高可信媒体或权威数据库，并标注无法确认的结论。",
        "source_quality_warning": "抽样复核关键事实，必要时用更可靠来源替换。",
        "low_credibility_source": "用官方来源、高可信媒体或权威数据库重新交叉验证。",
        "insufficient_official_evidence": "先补官方来源，再输出确定性结论。",
        "unresolved_after_repair": "在报告中明确标注为待确认，不要写成确定事实。",
        "resolved_after_repair": "保留新证据并在报告中引用对应来源。",
    }
    return actions.get(gap_type) or "建议人工抽样复核后再作为确定结论。"


def evaluate_gaps(
    task: str,
    ledger: list[dict[str, Any]],
    urls: list[str],
) -> dict[str, Any]:
    request = extract_competitive_request(task)
    competitors = request.get("competitors") or []
    dimensions = request.get("dimensions") or []
    gaps: list[dict[str, Any]] = []

    for competitor in competitors:
        for dimension in dimensions:
            matched = [
                item for item in ledger
                if item.get("competitor") == competitor and item.get("dimension") == dimension
            ]
            if not matched:
                gaps.append(_gap(
                    "missing_dimension_evidence",
                    competitor,
                    dimension,
                    f"{competitor} 缺少“{dimension}”维度的结构化证据。",
                ))

    official_coverage = competitor_official_coverage(request, urls)
    for competitor in official_coverage.get("missing_competitors") or []:
        gaps.append(_gap(
            "missing_official_source",
            competitor,
            "官方来源",
            f"{competitor} 缺少可识别官方来源，关键事实可信度不足。",
        ))

    if "最近" in (request.get("time_range") or ""):
        outdated = [
            item for item in ledger
            if str(item.get("time_hint", "")).startswith("2025")
        ][:5]
        if outdated:
            gaps.append({
                "id": f"gap_{len(gaps) + 1}",
                "type": "time_scope_risk",
                "competitor": "",
                "dimension": "近期产品更新",
                "reason": "部分证据包含 2025 年时间点，可能不符合最近时间范围口径。",
                "severity": "medium",
                "suggested_queries": _suggested_queries(request, "", "近期产品更新", official=False),
                "recommended_tools": ["repair_search"],
            })

    ranked = _rank_gaps(gaps)
    return {
        "evaluated_at": datetime.now().isoformat(),
        "needs_repair": bool(ranked),
        "overall_risk": "high" if len(ranked) >= 3 else ("medium" if ranked else "low"),
        "gaps": ranked,
        "coverage": {
            "competitors": len(competitors),
            "dimensions": len(dimensions),
            "evidence_items": len(ledger),
            "source_urls": len(urls),
            "official_covered_competitors": official_coverage.get("covered_competitors", []),
            "official_missing_competitors": official_coverage.get("missing_competitors", []),
        },
    }


def _gap(gap_type: str, competitor: str, dimension: str, reason: str) -> dict[str, Any]:
    return {
        "id": "",
        "type": gap_type,
        "competitor": competitor,
        "dimension": dimension,
        "reason": reason,
        "user_message": _gap_user_message(gap_type, competitor, dimension, reason),
        "suggested_action": _gap_suggested_action(gap_type, competitor, dimension),
        "severity": "high" if gap_type == "missing_official_source" else "medium",
        "suggested_queries": _suggested_queries({}, competitor, dimension, official=gap_type == "missing_official_source"),
        "recommended_tools": ["repair_search"],
    }


def _rank_gaps(gaps: list[dict[str, Any]]) -> list[dict[str, Any]]:
    priority = {
        "missing_official_source": 0,
        "missing_dimension_evidence": 1,
        "time_scope_risk": 2,
    }
    ranked = sorted(gaps, key=lambda item: priority.get(item.get("type"), 9))
    for index, gap in enumerate(ranked[:MAX_REPAIR_GAPS], start=1):
        gap["id"] = f"gap_{index}"
    return ranked[:MAX_REPAIR_GAPS]


def _suggested_queries(
    request: dict[str, Any],
    competitor: str,
    dimension: str,
    official: bool = False,
) -> list[str]:
    topic = request.get("research_topic") or "竞品研究"
    official_terms = "官网 官方 公告 帮助中心 定价 更新日志" if official else "公开资料"
    if competitor:
        return [f"{competitor} {dimension} {official_terms}"]
    return [f"{topic} {dimension} 最近 更新 官方 公告"]


async def plan_repair_tool_calls(researcher, task: str, gap_evaluation: dict[str, Any]) -> list[dict[str, Any]]:
    gaps = gap_evaluation.get("gaps") or []
    if not gaps:
        return []

    prompt = f"""你是竞品研究 Agent 的 Repair Planner。
根据以下证据缺口，选择最小必要的受控工具调用。只能使用 repair_search 工具。
最多输出 {MAX_REPAIR_QUERIES} 个 tool_calls。每个 query 必须是自然语言搜索词，不要使用 site:、OR、AND 等搜索操作符。

研究任务：
{task}

证据缺口 JSON：
{json.dumps(gaps, ensure_ascii=False, indent=2)}

请只返回 JSON，格式如下：
{{
  "tool_calls": [
    {{
      "tool": "repair_search",
      "arguments": {{"query": "补搜 query", "gap_ids": ["gap_1"]}},
      "reason": "为什么需要补搜"
    }}
  ]
}}
"""
    try:
        response = await create_chat_completion(
            model=researcher.cfg.strategic_llm_model,
            messages=[{"role": "user", "content": prompt}],
            llm_provider=researcher.cfg.strategic_llm_provider,
            max_tokens=researcher.cfg.strategic_token_limit,
            llm_kwargs=researcher.cfg.llm_kwargs,
            reasoning_effort=ReasoningEfforts.Low.value,
            cost_callback=researcher.add_costs,
            **researcher.kwargs,
        )
        parsed = json_repair.loads(response)
        calls = parsed.get("tool_calls") if isinstance(parsed, dict) else []
    except Exception:
        calls = []

    validated = _validate_tool_calls(calls)
    if validated:
        return validated
    return _fallback_tool_calls(gaps)


def _validate_tool_calls(calls: Any) -> list[dict[str, Any]]:
    if not isinstance(calls, list):
        return []
    validated = []
    seen_queries = set()
    for call in calls:
        if not isinstance(call, dict) or call.get("tool") != "repair_search":
            continue
        args = call.get("arguments") or {}
        query = str(args.get("query") or "").strip()
        if not query or query in seen_queries:
            continue
        seen_queries.add(query)
        validated.append({
            "tool": "repair_search",
            "arguments": {
                "query": query,
                "gap_ids": [str(item) for item in (args.get("gap_ids") or [])],
            },
            "reason": str(call.get("reason") or "补充证据缺口"),
        })
        if len(validated) >= MAX_REPAIR_QUERIES:
            break
    return validated


def _fallback_tool_calls(gaps: list[dict[str, Any]]) -> list[dict[str, Any]]:
    calls = []
    for gap in gaps[:MAX_REPAIR_QUERIES]:
        query = (gap.get("suggested_queries") or [""])[0]
        if not query:
            continue
        calls.append({
            "tool": "repair_search",
            "arguments": {"query": query, "gap_ids": [gap.get("id", "")]},
            "reason": gap.get("reason", "补充证据缺口"),
        })
    return calls


def _gap_key(gap: dict[str, Any]) -> str:
    return "|".join([
        str(gap.get("type") or ""),
        str(gap.get("competitor") or ""),
        str(gap.get("dimension") or ""),
    ])


def _build_candidate_official_sources(
    task: str,
    sources: list[dict[str, Any]],
    context: str = "",
) -> dict[str, list[dict[str, Any]]]:
    request = extract_competitive_request(task)
    candidates: dict[str, list[dict[str, Any]]] = {}
    competitors = [str(item) for item in request.get("competitors") or [] if str(item)]

    for competitor in competitors:
        aliases = _competitor_aliases(competitor)
        seen_urls = set()
        for source in sources or []:
            url = _source_url(source)
            title = str(source.get("title") or source.get("name") or "")
            text = " ".join([url, title, _source_text(source)[:1200]])
            lowered = text.lower()
            if not _contains_alias(text, aliases):
                continue
            if not any(term.lower() in lowered for term in OFFICIAL_CANDIDATE_TERMS):
                continue
            if url in seen_urls:
                continue
            seen_urls.add(url)
            candidates.setdefault(competitor, []).append({
                "url": url,
                "title": title[:120],
                "reason": "competitor_name_with_official_signal",
            })

        if context and competitor not in candidates:
            lowered_context = context.lower()
            if _contains_alias(context, aliases) and any(term.lower() in lowered_context for term in OFFICIAL_CANDIDATE_TERMS):
                candidates.setdefault(competitor, []).append({
                    "url": "",
                    "title": "repair_context",
                    "reason": "repair_context_with_official_signal",
                })

    return candidates


def _compare_gap_evaluations(
    initial: dict[str, Any],
    final: dict[str, Any],
    repair_actions: list[dict[str, Any]],
    before_evidence_count: int,
    after_evidence_count: int,
    repaired_source_count: int,
    candidate_official_sources: dict[str, list[dict[str, Any]]],
) -> dict[str, Any]:
    initial_gaps = initial.get("hard_gates") or initial.get("gaps") or []
    final_gaps = final.get("hard_gates") or final.get("gaps") or []
    final_keys = {_gap_key(gap) for gap in final_gaps}
    resolved = [gap for gap in initial_gaps if _gap_key(gap) not in final_keys]
    unresolved = [gap for gap in initial_gaps if _gap_key(gap) in final_keys]

    if not initial.get("needs_repair"):
        status = "not_triggered"
    elif not repair_actions:
        status = "unresolved"
    elif initial_gaps and not final_gaps:
        status = "resolved"
    elif resolved:
        status = "partially_resolved"
    else:
        status = "unresolved"

    return {
        "status": status,
        "initial_hard_gate_count": len(initial_gaps),
        "final_hard_gate_count": len(final_gaps),
        "resolved_gaps": resolved,
        "unresolved_gaps": unresolved,
        "new_hard_gates": [gap for gap in final_gaps if _gap_key(gap) not in {_gap_key(item) for item in initial_gaps}],
        "repair_action_count": len(repair_actions),
        "repaired_source_count": repaired_source_count,
        "evidence_added": max(after_evidence_count - before_evidence_count, 0),
        "candidate_official_sources": candidate_official_sources,
    }


def _enterprise_suggested_queries(
    request: dict[str, Any],
    competitor: str,
    dimension: str,
    official: bool = False,
) -> list[str]:
    topic = request.get("research_topic") or "竞品研究"
    official_terms = "官网 官方 公告 帮助中心 定价 更新日志 母公司 业务介绍" if official else "公开资料"
    if competitor:
        return [f"{competitor} {dimension} {official_terms}"]
    return [f"{topic} {dimension} 最近 更新 官方 公告"]


def _enterprise_gap(
    gap_type: str,
    competitor: str,
    dimension: str,
    reason: str,
    request: dict[str, Any] | None = None,
) -> dict[str, Any]:
    severity = {
        "unknown_official_profile": "high",
        "missing_official_source": "high",
        "weak_critical_evidence": "high",
        "missing_dimension_evidence": "medium",
        "time_scope_risk": "medium",
        "time_uncertain_evidence": "medium",
        "source_quality_risk": "medium",
        "source_quality_warning": "low",
    }.get(gap_type, "medium")
    official_needed = gap_type in {
        "unknown_official_profile",
        "missing_official_source",
        "weak_critical_evidence",
        "time_scope_risk",
        "time_uncertain_evidence",
    }
    return {
        "id": "",
        "type": gap_type,
        "bucket": _gap_bucket(gap_type),
        "competitor": competitor,
        "dimension": dimension,
        "reason": reason,
        "user_message": _gap_user_message(gap_type, competitor, dimension, reason),
        "suggested_action": _gap_suggested_action(gap_type, competitor, dimension),
        "severity": severity,
        "suggested_queries": _enterprise_suggested_queries(request or {}, competitor, dimension, official=official_needed),
        "recommended_tools": ["repair_search"] if _gap_bucket(gap_type) == "hard_gate" else [],
    }


def _enterprise_rank_gaps(gaps: list[dict[str, Any]], limit: int = MAX_REPAIR_GAPS) -> list[dict[str, Any]]:
    priority = {
        "unknown_official_profile": 0,
        "missing_official_source": 0,
        "weak_critical_evidence": 1,
        "missing_dimension_evidence": 2,
        "time_scope_risk": 3,
        "time_uncertain_evidence": 3,
        "source_quality_risk": 4,
        "source_quality_warning": 5,
    }
    ranked = sorted(gaps, key=lambda item: priority.get(item.get("type"), 9))
    for index, gap in enumerate(ranked[:limit], start=1):
        gap["id"] = f"gap_{index}"
    return ranked[:limit]


def evaluate_gaps(
    task: str,
    ledger: list[dict[str, Any]],
    urls: list[str],
) -> dict[str, Any]:
    request = extract_competitive_request(task)
    competitors = request.get("competitors") or []
    dimensions = request.get("dimensions") or []
    hard_gates: list[dict[str, Any]] = []
    soft_warnings: list[dict[str, Any]] = []
    dimension_coverage: dict[str, dict[str, bool]] = {}

    for competitor in competitors:
        competitor_key = str(competitor)
        dimension_coverage[competitor_key] = {}
        for dimension in dimensions:
            dimension_key = str(dimension)
            matched = [
                item for item in ledger
                if item.get("competitor") == competitor and item.get("dimension") == dimension
            ]
            dimension_coverage[competitor_key][dimension_key] = bool(matched)
            if not matched:
                hard_gates.append(_enterprise_gap(
                    "missing_dimension_evidence",
                    competitor_key,
                    dimension_key,
                    f"{competitor_key} 缺少“{dimension_key}”维度的结构化证据。",
                    request,
                ))
                continue

            if _is_critical_dimension(dimension_key) and not any(
                item.get("source_tier") in ("S", "A") for item in matched
            ):
                hard_gates.append(_enterprise_gap(
                    "weak_critical_evidence",
                    competitor_key,
                    dimension_key,
                    f"{competitor_key} 的“{dimension_key}”属于关键事实，但当前证据没有官方源或高可信来源支撑。",
                    request,
                ))

    official_coverage = competitor_official_coverage(request, urls)
    for competitor in official_coverage.get("unknown_profile_competitors") or []:
        hard_gates.append(_enterprise_gap(
            "unknown_official_profile",
            str(competitor),
            "官方主体识别",
            f"{competitor} 未识别到可匹配的官方主体/官网资料，需要补搜确认主体关系和官网口径。",
            request,
        ))

    for competitor in official_coverage.get("missing_competitors") or []:
        hard_gates.append(_enterprise_gap(
            "missing_official_source",
            str(competitor),
            "官方来源",
            f"{competitor} 已识别官方主体，但当前来源里缺少可识别官方 URL，关键事实可信度不足。",
            request,
        ))

    if _is_time_scope_requested(request, [str(dimension) for dimension in dimensions]):
        recent_items = [
            item for item in ledger
            if _is_recent_dimension(str(item.get("dimension") or ""))
        ]
        if [item for item in recent_items if not item.get("time_hint")]:
            hard_gates.append(_enterprise_gap(
                "time_uncertain_evidence",
                "",
                "近期产品更新",
                "近期更新类证据缺少可识别日期，无法判断是否符合用户要求的时间范围。",
                request,
            ))
        if [
            item for item in recent_items
            if _time_out_of_scope(str(item.get("time_hint") or ""), request)
        ]:
            hard_gates.append(_enterprise_gap(
                "time_scope_risk",
                "",
                "近期产品更新",
                "部分近期更新证据的日期不在用户要求的时间范围内，需要补搜更近的官方公告或更新日志。",
                request,
            ))

    source_tiers = build_source_tier_summary(urls)
    tier_counts = source_tiers.get("counts") or {}
    source_count = len(urls)
    c_rate = (tier_counts.get("C", 0) / source_count) if source_count else 0
    if source_count >= 3 and c_rate > 0.5:
        hard_gates.append(_enterprise_gap(
            "source_quality_risk",
            "",
            "来源质量",
            "C 类社区/自媒体/弱验证来源占比超过 50%，关键结论可能被低可信来源污染。",
            request,
        ))
    elif source_count >= 3 and c_rate > 0.3:
        soft_warnings.append(_enterprise_gap(
            "source_quality_warning",
            "",
            "来源质量",
            "C 类社区/自媒体/弱验证来源占比超过 30%，建议人工抽样核验关键事实。",
            request,
        ))

    ranked_hard_gates = _enterprise_rank_gaps(hard_gates)
    ranked_soft_warnings = _enterprise_rank_gaps(soft_warnings, limit=6)
    return {
        "evaluated_at": datetime.now().isoformat(),
        "strictness": "interview_demo_enterprise",
        "needs_repair": bool(ranked_hard_gates),
        "overall_risk": (
            "high" if len(ranked_hard_gates) >= 3
            else ("medium" if ranked_hard_gates else ("low_with_warnings" if ranked_soft_warnings else "low"))
        ),
        "gaps": ranked_hard_gates,
        "hard_gates": ranked_hard_gates,
        "soft_warnings": ranked_soft_warnings,
        "coverage": {
            "competitors": len(competitors),
            "dimensions": len(dimensions),
            "evidence_items": len(ledger),
            "source_urls": len(urls),
            "official_covered_competitors": official_coverage.get("covered_competitors", []),
            "official_missing_competitors": official_coverage.get("missing_competitors", []),
            "official_unknown_profile_competitors": official_coverage.get("unknown_profile_competitors", []),
            "dimension_coverage": dimension_coverage,
            "source_tier_counts": tier_counts,
            "low_credibility_source_rate": round(c_rate, 4),
        },
        "metrics": {
            "source_count": source_count,
            "source_tier_counts": tier_counts,
            "official_source_count": tier_counts.get("S", 0),
            "authority_source_count": tier_counts.get("A", 0),
            "low_credibility_source_count": tier_counts.get("C", 0),
            "low_credibility_source_rate": round(c_rate, 4),
            "dimension_coverage": dimension_coverage,
        },
    }


def evaluate_gaps(
    task: str,
    ledger: list[dict[str, Any]],
    urls: list[str],
    candidate_official_sources: dict[str, list[dict[str, Any]]] | None = None,
) -> dict[str, Any]:
    request = extract_competitive_request(task)
    competitors = [str(item) for item in request.get("competitors") or [] if str(item)]
    dimensions = [str(item) for item in request.get("dimensions") or [] if str(item)]
    candidate_official_sources = candidate_official_sources or {}
    hard_gates: list[dict[str, Any]] = []
    soft_warnings: list[dict[str, Any]] = []
    dimension_coverage: dict[str, dict[str, bool]] = {}

    for competitor in competitors:
        dimension_coverage[competitor] = {}
        for dimension in dimensions:
            matched = [
                item for item in ledger
                if str(item.get("competitor") or "") == competitor
                and str(item.get("dimension") or "") == dimension
            ]
            dimension_coverage[competitor][dimension] = bool(matched)
            if not matched:
                hard_gates.append(_enterprise_gap(
                    "missing_dimension_evidence",
                    competitor,
                    dimension,
                    f"{competitor} 缺少“{dimension}”维度的结构化证据。",
                    request,
                ))
                continue

            if _is_critical_dimension(dimension) and not any(item.get("source_tier") in ("S", "A") for item in matched):
                hard_gates.append(_enterprise_gap(
                    "weak_critical_evidence",
                    competitor,
                    dimension,
                    f"{competitor} 的“{dimension}”属于关键事实，但当前证据没有官方源或高可信来源支撑。",
                    request,
                ))

    official_coverage = competitor_official_coverage(request, urls)
    for competitor in official_coverage.get("unknown_profile_competitors") or []:
        competitor_key = str(competitor)
        if candidate_official_sources.get(competitor_key):
            soft_warnings.append(_enterprise_gap(
                "candidate_official_source_found",
                competitor_key,
                "\u5b98\u65b9\u4e3b\u4f53\u8bc6\u522b",
                f"{competitor_key} 未在官方来源库中匹配到主体，但补搜找到了候选官方来源；需要人工确认主体归属。",
                request,
            ))
        else:
            hard_gates.append(_enterprise_gap(
                "unknown_official_profile",
                competitor_key,
                "\u5b98\u65b9\u4e3b\u4f53\u8bc6\u522b",
                f"{competitor_key} 未识别到可匹配的官方主体/官网资料，需要补搜确认主体关系和官网口径。",
                request,
            ))

    for competitor in official_coverage.get("missing_competitors") or []:
        hard_gates.append(_enterprise_gap(
            "missing_official_source",
            str(competitor),
            "\u5b98\u65b9\u6765\u6e90",
            f"{competitor} 已识别官方主体，但当前来源里缺少可识别官方 URL，关键事实可信度不足。",
            request,
        ))

    if _is_time_scope_requested(request, dimensions):
        recent_items = [item for item in ledger if _is_recent_dimension(str(item.get("dimension") or ""))]
        if [item for item in recent_items if not item.get("time_hint")]:
            hard_gates.append(_enterprise_gap(
                "time_uncertain_evidence",
                "",
                "\u8fd1\u671f\u4ea7\u54c1\u66f4\u65b0",
                "近期更新类证据缺少可识别日期，无法判断是否符合用户要求的时间范围。",
                request,
            ))
        if [item for item in recent_items if _time_out_of_scope(str(item.get("time_hint") or ""), request)]:
            hard_gates.append(_enterprise_gap(
                "time_scope_risk",
                "",
                "\u8fd1\u671f\u4ea7\u54c1\u66f4\u65b0",
                "部分近期更新证据的日期不在用户要求的时间范围内，需要补搜更近的官方公告或更新日志。",
                request,
            ))

    source_tiers = build_source_tier_summary(urls)
    tier_counts = source_tiers.get("counts") or {}
    source_count = len(urls)
    c_rate = (tier_counts.get("C", 0) / source_count) if source_count else 0
    if source_count >= 3 and c_rate > 0.5:
        hard_gates.append(_enterprise_gap(
            "source_quality_risk",
            "",
            "\u6765\u6e90\u8d28\u91cf",
            "C 类社区/自媒体/弱验证来源占比超过 50%，关键结论可能被低可信来源污染。",
            request,
        ))
    elif source_count >= 3 and c_rate > 0.3:
        soft_warnings.append(_enterprise_gap(
            "source_quality_warning",
            "",
            "\u6765\u6e90\u8d28\u91cf",
            "C 类社区/自媒体/弱验证来源占比超过 30%，建议人工抽样核验关键事实。",
            request,
        ))

    ranked_hard_gates = _enterprise_rank_gaps(hard_gates)
    ranked_soft_warnings = _enterprise_rank_gaps(soft_warnings, limit=6)
    return {
        "evaluated_at": datetime.now().isoformat(),
        "strictness": "interview_demo_enterprise",
        "needs_repair": bool(ranked_hard_gates),
        "overall_risk": (
            "high" if len(ranked_hard_gates) >= 3
            else ("medium" if ranked_hard_gates else ("low_with_warnings" if ranked_soft_warnings else "low"))
        ),
        "gaps": ranked_hard_gates,
        "hard_gates": ranked_hard_gates,
        "soft_warnings": ranked_soft_warnings,
        "coverage": {
            "competitors": len(competitors),
            "dimensions": len(dimensions),
            "evidence_items": len(ledger),
            "source_urls": len(urls),
            "official_covered_competitors": official_coverage.get("covered_competitors", []),
            "official_missing_competitors": official_coverage.get("missing_competitors", []),
            "official_unknown_profile_competitors": official_coverage.get("unknown_profile_competitors", []),
            "candidate_official_sources": candidate_official_sources,
            "dimension_coverage": dimension_coverage,
            "source_tier_counts": tier_counts,
            "low_credibility_source_rate": round(c_rate, 4),
        },
        "metrics": {
            "source_count": source_count,
            "source_tier_counts": tier_counts,
            "official_source_count": tier_counts.get("S", 0),
            "authority_source_count": tier_counts.get("A", 0),
            "low_credibility_source_count": tier_counts.get("C", 0),
            "low_credibility_source_rate": round(c_rate, 4),
            "dimension_coverage": dimension_coverage,
            "candidate_official_source_count": sum(len(items) for items in candidate_official_sources.values()),
        },
    }


async def execute_repair_tool_calls(researcher, task: str, tool_calls: list[dict[str, Any]]) -> tuple[str, list[dict[str, Any]], list[dict[str, Any]]]:
    repair_contexts: list[str] = []
    trace_calls: list[dict[str, Any]] = []
    repaired_sources: list[dict[str, Any]] = []

    for index, call in enumerate(tool_calls, start=1):
        query = call["arguments"]["query"]
        call_id = f"tool_{index}"
        started_at = datetime.now().isoformat()
        before_urls = set(researcher.visited_urls)
        try:
            new_urls, prefetched = await researcher.research_conductor._search_relevant_source_urls(
                query,
                researcher.query_domains,
            )
            new_urls = filter_usable_source_urls(new_urls)
            trace_calls.append(_trace_call(
                call_id,
                "web_search",
                {"query": query},
                call.get("reason", ""),
                "success",
                {"url_count": len(new_urls), "urls": new_urls[:8]},
                started_at,
            ))

            scraped = await researcher.scraper_manager.browse_urls(new_urls)
            scraped.extend(prefetched)
            repaired_sources.extend(scraped)
            trace_calls.append(_trace_call(
                f"{call_id}_scrape",
                "scrape_url",
                {"url_count": len(new_urls)},
                "抓取补搜 URL 正文",
                "success",
                {"scraped_count": len(scraped), "new_visited_urls": len(set(researcher.visited_urls) - before_urls)},
                started_at,
            ))

            if scraped:
                context = await researcher.context_manager.get_similar_content_by_query(query, scraped)
                if context:
                    repair_contexts.append(context)
                trace_calls.append(_trace_call(
                    f"{call_id}_extract",
                    "extract_evidence",
                    {"query": query},
                    "从补搜内容中提取相关上下文和证据",
                    "success",
                    {"context_chars": len(str(context or ""))},
                    started_at,
                ))
            else:
                trace_calls.append(_trace_call(
                    f"{call_id}_extract",
                    "extract_evidence",
                    {"query": query},
                    "没有可抽取的补搜内容",
                    "skipped",
                    {"context_chars": 0},
                    started_at,
                ))
        except Exception as exc:
            trace_calls.append(_trace_call(
                call_id,
                "repair_search",
                {"query": query},
                call.get("reason", ""),
                "failed",
                {"error": str(exc)[:300]},
                started_at,
            ))

    return "\n\n".join(repair_contexts), repaired_sources, trace_calls


def _trace_call(
    call_id: str,
    tool: str,
    arguments: dict[str, Any],
    reason: str,
    status: str,
    observation: dict[str, Any],
    started_at: str,
) -> dict[str, Any]:
    return {
        "id": call_id,
        "tool": tool,
        "arguments": arguments,
        "reason": reason,
        "status": status,
        "observation": observation,
        "started_at": started_at,
        "finished_at": datetime.now().isoformat(),
    }


def _build_agent_trace(
    enabled: bool,
    gap_evaluation: dict[str, Any],
    tool_calls: list[dict[str, Any]],
    executed_calls: list[dict[str, Any]],
    before_evidence_count: int,
    after_evidence_count: int,
) -> dict[str, Any]:
    needs_repair = gap_evaluation.get("needs_repair", False)
    return {
        "enabled": enabled,
        "paradigm": "plan-and-execute + evidence-gate-driven remediation",
        "max_repair_rounds": 1,
        "phases": [
            {"name": "plan", "status": "completed", "summary": "复用 GPT Researcher Planner 生成搜索子问题。"},
            {"name": "execute", "status": "completed", "summary": "完成首次搜索、抓取和上下文压缩。"},
            {"name": "evidence_gate", "status": "completed", "summary": f"材料门控发现 {len(gap_evaluation.get('gaps') or [])} 个优先缺口。"},
            {"name": "repair", "status": "completed" if needs_repair else "skipped", "summary": f"执行 {len(tool_calls)} 个受控补救工具请求。"},
            {"name": "write", "status": "pending", "summary": "基于补救后的上下文生成最终报告。"},
        ],
        "tool_policy": {
            "mode": "allowlist",
            "allowed_tools": ["web_search", "scrape_url", "extract_evidence", "evidence_gate", "repair_search"],
        },
        "planned_tool_calls": tool_calls,
        "tool_calls": executed_calls,
        "evidence_delta": {
            "before": before_evidence_count,
            "after": after_evidence_count,
            "added": max(after_evidence_count - before_evidence_count, 0),
        },
    }


def _format_evidence_context(ledger: list[dict[str, Any]]) -> str:
    if not ledger:
        return ""
    lines = ["## Agent 证据台账"]
    for item in ledger[:40]:
        source = item.get("source_url") or "无 URL"
        official = "官方倾向" if item.get("is_official_like") else item.get("source_tier", "U")
        lines.append(
            f"- [{item.get('competitor')}/{item.get('dimension')}] {item.get('claim')} "
            f"来源：{source}；来源等级：{official}；时间：{item.get('time_hint') or '未识别'}"
        )
    return "\n".join(lines)


async def run_competitive_agent_repair(researcher, task: str) -> dict[str, Any] | None:
    if not is_competitive_research_task(task):
        return None

    initial_context = str(researcher.context or "")
    initial_sources = researcher.get_research_sources()
    initial_urls = researcher.get_source_urls()
    initial_ledger = build_evidence_ledger(task, initial_sources, initial_context)
    initial_gap_evaluation = evaluate_gaps(task, initial_ledger, initial_urls)
    repair_enabled = should_execute_evidence_repair()
    tool_calls = (
        await plan_repair_tool_calls(researcher, task, initial_gap_evaluation)
        if repair_enabled and initial_gap_evaluation.get("needs_repair")
        else []
    )

    await stream_output(
        "logs",
        "agent_evaluation",
        f"Evidence Gate found {len(initial_gap_evaluation.get('gaps') or [])} priority gap(s).",
        researcher.websocket,
        True,
        initial_gap_evaluation,
    )

    repair_context = ""
    repaired_sources: list[dict[str, Any]] = []
    executed_calls: list[dict[str, Any]] = []
    if repair_enabled and tool_calls:
        repair_context, repaired_sources, executed_calls = await execute_repair_tool_calls(researcher, task, tool_calls)

    final_context = initial_context
    if repair_context:
        final_context = f"{initial_context}\n\n## Agent 补搜上下文\n{repair_context}"

    final_sources = [*researcher.get_research_sources(), *repaired_sources]
    repaired_urls = [_source_url(source) for source in repaired_sources if _source_url(source)]
    final_urls: list[str] = []
    seen_urls = set()
    for url in [*initial_urls, *researcher.get_source_urls(), *repaired_urls]:
        if url and url not in seen_urls:
            seen_urls.add(url)
            final_urls.append(url)

    final_ledger = build_evidence_ledger(task, final_sources, final_context)
    candidate_official_sources = _build_candidate_official_sources(task, repaired_sources, repair_context) if tool_calls else {}
    final_gap_evaluation = evaluate_gaps(task, final_ledger, final_urls, candidate_official_sources)
    repair_outcome = _compare_gap_evaluations(
        initial_gap_evaluation,
        final_gap_evaluation,
        tool_calls,
        len(initial_ledger),
        len(final_ledger),
        len(repaired_sources),
        candidate_official_sources,
    )

    evidence_context = _format_evidence_context(final_ledger)
    if evidence_context:
        final_context = f"{final_context}\n\n{evidence_context}"
    if repair_outcome.get("unresolved_gaps"):
        unresolved_lines = [
            (
                f"- {_gap_target(str(gap.get('competitor') or ''), str(gap.get('dimension') or ''))}: "
                f"{gap.get('user_message') or gap.get('reason')}"
                + (f" 建议：{gap.get('suggested_action')}" if gap.get("suggested_action") else "")
            )
            for gap in repair_outcome.get("unresolved_gaps") or []
        ]
        final_context = (
            f"{final_context}\n\n## 待人工复核的信息\n"
            "以下信息在补充检索后仍未完全确认，最终报告需要用用户能理解的语言标注为待确认，不要输出内部字段名：\n"
            + "\n".join(unresolved_lines)
        )
    researcher.context = final_context

    agent_trace = _build_agent_trace(
        repair_enabled,
        final_gap_evaluation,
        tool_calls,
        executed_calls,
        len(initial_ledger),
        len(final_ledger),
    )
    metadata = {
        "agent_trace": agent_trace,
        "gap_evaluation": final_gap_evaluation,
        "initial_gap_evaluation": initial_gap_evaluation,
        "final_gap_evaluation": final_gap_evaluation,
        "repair_outcome": repair_outcome,
        "evidence_ledger": final_ledger,
        "repair_actions": tool_calls,
        "repair_context_chars": len(repair_context),
        "repaired_source_count": len(repaired_sources),
    }
    researcher.competitive_agent_metadata = metadata

    await stream_output(
        "logs",
        "agent_repair_summary",
        (
            f"Agent repair completed: {len(executed_calls)} tool step(s), "
            f"evidence {len(initial_ledger)} -> {len(final_ledger)}, "
            f"outcome={repair_outcome.get('status')}."
        ),
        researcher.websocket,
        True,
        metadata,
    )
    return metadata
