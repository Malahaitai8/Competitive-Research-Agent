import json
import os
import re
from datetime import datetime
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

from gpt_researcher.competitive_sources import (
    build_source_tier_summary,
    classify_source_url,
    competitor_official_coverage,
    filter_usable_source_urls,
)
from .semantic_validation import build_semantic_validation


COMPETITIVE_MARKER = "[COMPETITIVE_RESEARCH_MODE]"

REQUIRED_REPORT_SECTIONS = [
    "研究范围与口径",
    "竞品主体关系与品牌口径",
    "竞品概览",
    "产品定位与目标用户",
    "核心功能对比矩阵",
    "定价与商业化方式",
    "近期产品更新",
    "产品差异与竞争优势",
    "市场空白与产品机会",
    "研究限制与待确认信息",
    "信息来源",
]

OFFICIAL_SOURCE_HINTS = [
    "official",
    "pricing",
    "price",
    "docs",
    "help",
    "support",
    "changelog",
    "release",
    "updates",
    "blog",
    "about",
]


def is_competitive_research_task(task: str | None) -> bool:
    return bool(task and COMPETITIVE_MARKER in task)


def _extract_line_value(task: str, label: str) -> str:
    match = re.search(rf"^{re.escape(label)}[:：](.+)$", task, flags=re.MULTILINE)
    return match.group(1).strip() if match else ""


def _split_cn_list(value: str) -> list[str]:
    return [item.strip() for item in re.split(r"[、,，\n]", value or "") if item.strip()]


def _extract_line_value(task: str, label: str) -> str:
    match = re.search(rf"^{re.escape(label)}[:：](.+)$", task or "", flags=re.MULTILINE)
    return match.group(1).strip() if match else ""


def _split_cn_list(value: str) -> list[str]:
    return [item.strip() for item in re.split(r"[、，,\n]", value or "") if item.strip()]


def _extract_line_value(task: str, label: str) -> str:
    for line in (task or "").splitlines():
        stripped = line.strip()
        for sep in (":", "\uff1a"):
            prefix = f"{label}{sep}"
            if stripped.startswith(prefix):
                return stripped[len(prefix):].strip()
    return ""


def extract_competitive_request(task: str) -> dict[str, Any]:
    competitors = _split_cn_list(_extract_line_value(task, "竞品范围"))
    dimensions = _split_cn_list(_extract_line_value(task, "研究维度"))
    return {
        "research_topic": _extract_line_value(task, "研究主题"),
        "competitors": competitors,
        "dimensions": dimensions,
        "region": _extract_line_value(task, "研究地区"),
        "time_range": _extract_line_value(task, "时间范围"),
        "extra_requirements": _extract_line_value(task, "补充要求"),
    }


def extract_competitive_request(task: str) -> dict[str, Any]:
    competitors = _split_cn_list(_extract_line_value(task, "\u7ade\u54c1\u8303\u56f4"))
    dimensions = _split_cn_list(_extract_line_value(task, "\u7814\u7a76\u7ef4\u5ea6"))
    return {
        "research_topic": _extract_line_value(task, "\u7814\u7a76\u4e3b\u9898"),
        "competitors": competitors,
        "competitor_aliases": {competitor: _competitor_aliases(competitor) for competitor in competitors},
        "dimensions": dimensions,
        "region": _extract_line_value(task, "\u7814\u7a76\u5730\u533a"),
        "time_range": _extract_line_value(task, "\u65f6\u95f4\u8303\u56f4"),
        "extra_requirements": _extract_line_value(task, "\u8865\u5145\u8981\u6c42"),
    }


def extract_urls(text: str) -> list[str]:
    urls = re.findall(r"https?://[^\s)\]>\"']+", text or "")
    normalized = []
    seen = set()
    for url in urls:
        clean_url = url.rstrip(".,;")
        if clean_url not in seen:
            seen.add(clean_url)
            normalized.append(clean_url)
    return filter_usable_source_urls(normalized)


TRACKING_QUERY_KEYS = {
    "fbclid",
    "gclid",
    "mc_cid",
    "mc_eid",
    "ref",
    "referrer",
    "source",
}

def _normalize_citation_url(url: str) -> str:
    parsed = urlparse((url or "").strip())
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.netloc:
        return ""

    retained_query = []
    for key, value in parse_qsl(parsed.query, keep_blank_values=True):
        lowered = key.lower()
        if lowered.startswith("utm_") or lowered in TRACKING_QUERY_KEYS:
            continue
        retained_query.append((key, value))

    path = parsed.path or "/"
    if path != "/":
        path = path.rstrip("/")
    normalized = parsed._replace(
        scheme=parsed.scheme.lower(),
        netloc=parsed.netloc.lower(),
        path=path,
        query=urlencode(retained_query, doseq=True),
        fragment="",
    )
    return urlunparse(normalized)


def extract_report_citation_urls(report: str) -> list[str]:
    image_urls = {
        _normalize_citation_url(url)
        for url in re.findall(r"!\[[^\]]*]\((https?://[^)\s]+)", report or "")
    }
    citations = []
    seen = set()
    for url in extract_urls(report):
        normalized = _normalize_citation_url(url)
        if not normalized or normalized in image_urls or normalized in seen:
            continue
        if re.search(r"\.(?:png|jpe?g|gif|webp|svg)(?:$|\?)", normalized, flags=re.IGNORECASE):
            continue
        seen.add(normalized)
        citations.append(normalized)
    return citations


def _reading_source_category(url: str) -> str:
    tier = classify_source_url(url)["tier"]
    return {
        "S": "official",
        "A": "authoritative",
        "B": "ordinary",
        "C": "weak_verification",
    }.get(tier, "ordinary")


def _short_claim(value: Any, limit: int = 54) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    return text if len(text) <= limit else f"{text[:limit].rstrip()}…"


def _attention_copy(claim: str) -> str:
    short = _short_claim(claim)
    if any(marker in claim for marker in ("价格", "会员", "订阅", "收费")):
        return f"“{short}”的价格信息建议复核官方定价页。"
    if any(marker in claim for marker in ("更新", "上线", "发布", "近期")):
        return f"“{short}”的近期更新信息建议复核官网公告。"
    return f"“{short}”暂缺充分公开资料支撑，建议结合原始来源阅读。"


def build_reading_context(
    request: dict[str, Any],
    report: str,
    semantic_validation: dict[str, Any] | None = None,
) -> dict[str, Any]:
    cited_urls = extract_report_citation_urls(report)
    classified = [
        {
            "url": url,
            "domain": _domain_from_url(url).removeprefix("www."),
            "category": _reading_source_category(url),
        }
        for url in cited_urls
    ]
    official_count = sum(item["category"] == "official" for item in classified)
    authoritative_count = sum(item["category"] == "authoritative" for item in classified)
    ordinary_count = sum(item["category"] == "ordinary" for item in classified)
    weak_verification_count = sum(item["category"] == "weak_verification" for item in classified)

    domain_map: dict[str, dict[str, Any]] = {}
    for item in classified:
        domain_entry = domain_map.setdefault(
            item["domain"],
            {
                "domain": item["domain"],
                "category": item["category"],
                "count": 0,
                "urls": [],
            },
        )
        domain_entry["count"] += 1
        domain_entry["urls"].append(item["url"])
    source_domains = sorted(domain_map.values(), key=lambda item: -item["count"])

    validation = semantic_validation or {}
    claim_validation = validation.get("claim_validation") or []
    supported_claims = [
        _short_claim(item.get("claim"))
        for item in claim_validation
        if item.get("claim")
        and item.get("status") == "supported"
        and (item.get("evidence") or int(item.get("matching_evidence_count") or 0) > 0)
    ][:2]

    attention_items = []
    for item in claim_validation:
        if item.get("claim") and item.get("status") in {
            "weakly_supported",
            "unsupported",
            "needs_human_review",
        }:
            attention_items.append(_attention_copy(str(item["claim"])))

    official_coverage = competitor_official_coverage(request, cited_urls)
    for competitor in official_coverage.get("missing_competitors") or []:
        attention_items.append(f"{competitor} 的官方公开资料较少，产品定位和关键信息建议复核官网。")
    attention_items = list(dict.fromkeys(attention_items))[:3]

    missing_items = []
    for gap in validation.get("semantic_gaps") or []:
        location = gap.get("location") or {}
        competitor = str(location.get("competitor") or "").strip()
        dimension = str(location.get("dimension") or location.get("section") or "").strip()
        if competitor and dimension:
            missing_items.append(f"{competitor}的{dimension}暂未找到足够可靠的公开资料。")
        elif dimension:
            missing_items.append(f"{dimension}暂未找到足够可靠的公开资料。")
    missing_items = list(dict.fromkeys(missing_items))[:3]

    total_count = len(cited_urls)
    supported_source_count = official_count + authoritative_count
    if not total_count:
        confidence_summary = "正文暂未检测到可核验的外部引用。"
    elif weak_verification_count:
        confidence_summary = "本报告同时使用官方、权威或普通公开资料，其中部分信息来自弱验证来源，相关结论建议结合原始页面确认。"
    elif supported_source_count == total_count:
        confidence_summary = "本报告引用以官方或权威公开资料为主，产品基础信息支撑较充分，具体结论仍建议结合原始页面阅读。"
    elif supported_source_count:
        confidence_summary = "本报告同时使用官方或权威资料与普通公开资料，价格和近期更新等时效性信息建议结合原始页面确认。"
    else:
        confidence_summary = "本报告主要依据普通公开资料生成，关键价格、产品能力和近期更新建议优先复核官网、帮助中心或官方公告。"

    selected_range = str(request.get("time_range") or "当前公开信息").strip() or "当前公开信息"
    if "最近" in selected_range:
        time_note = f"报告优先使用{selected_range}的公开信息；较早资料如有引用，仅用于理解产品定位和历史背景。"
    else:
        time_note = f"报告按“{selected_range}”口径整理公开信息；带有日期的事实请以原始页面为准。"

    return {
        "cited_source_count": total_count,
        "official_source_count": official_count,
        "authoritative_source_count": authoritative_count,
        "ordinary_source_count": ordinary_count,
        "weak_verification_source_count": weak_verification_count,
        "source_domains": source_domains,
        "supported_claims": supported_claims,
        "attention_items": attention_items,
        "time_scope": {
            "selected_range": selected_range,
            "note": time_note,
        },
        "missing_items": missing_items,
        "confidence_summary": confidence_summary,
    }


def _extract_sentences(text: str) -> list[str]:
    chunks = re.split(r"(?<=[。！？!?])\s+|\n+", text or "")
    return [chunk.strip() for chunk in chunks if chunk.strip()]


def _competitor_aliases(competitor: str) -> list[str]:
    aliases = [competitor]
    aliases.extend(re.split(r"[/／、,，]", competitor or ""))

    bracket_match = re.search(r"[（(]含(.+?)[）)]", competitor or "")
    if bracket_match:
        aliases.extend(_split_cn_list(bracket_match.group(1)))

    normalized = []
    for alias in aliases:
        clean_alias = re.sub(r"[（(].*?[）)]", "", alias).strip()
        if clean_alias:
            normalized.append(clean_alias)
            no_space_alias = re.sub(r"\s+", "", clean_alias)
            if no_space_alias != clean_alias:
                normalized.append(no_space_alias)

    if any("饿了么" in alias for alias in normalized):
        normalized.append("淘宝闪购")
    if any("淘宝闪购" in alias for alias in normalized):
        normalized.append("饿了么")
        normalized.append("淘宝")
    if any("美团" in alias for alias in normalized):
        normalized.append("美团")
    if any("京东" in alias for alias in normalized):
        normalized.append("京东")

    deduped = []
    seen = set()
    for alias in normalized:
        if alias not in seen:
            seen.add(alias)
            deduped.append(alias)
    return deduped


def _contains_alias(text: str, aliases: list[str]) -> bool:
    compact_text = re.sub(r"\s+", "", text or "")
    lowered_text = (text or "").lower()
    lowered_compact_text = compact_text.lower()
    return any(
        alias and (
            alias in text
            or re.sub(r"\s+", "", alias) in compact_text
            or alias.lower() in lowered_text
            or re.sub(r"\s+", "", alias).lower() in lowered_compact_text
        )
        for alias in aliases
    )


def _count_matches(text: str, values: list[str]) -> int:
    return sum(1 for value in values if value and value in text)


def _is_generic_research_scope_sentence(sentence: str) -> bool:
    text = sentence or ""
    generic_markers = (
        "本报告",
        "研究维度",
        "维度涵盖",
        "横向竞品研究",
        "做出选型决策",
        "了解产品差异",
        "研究范围",
    )
    return any(marker in text for marker in generic_markers)


def _dimension_family_keywords(dimension: str) -> set[str]:
    families: dict[str, set[str]] = {
        "positioning": {"产品定位", "定位", "主打", "面向", "场景"},
        "audience": {"目标用户", "用户", "人群", "学生", "职场", "开发者", "企业用户", "个人用户"},
        "features": {"核心功能", "功能", "能力", "搜索", "生成", "插件", "任务", "文件", "系统操作"},
        "pricing": {"会员价格", "价格", "会员", "订阅", "Pro", "收费", "免费"},
        "business": {"商业化方式", "商业化", "收费", "广告", "订阅"},
        "updates": {"近期更新", "更新", "发布", "上线", "新增", "近期"},
    }
    if "定位" in dimension:
        return families["positioning"]
    if "用户" in dimension:
        return families["audience"]
    if "功能" in dimension:
        return families["features"]
    if "价格" in dimension or "会员" in dimension:
        return families["pricing"]
    if "商业" in dimension:
        return families["business"]
    if "更新" in dimension:
        return families["updates"]
    return {dimension}


def _other_dimension_match_count(sentence: str, dimension: str) -> int:
    current = _dimension_family_keywords(dimension)
    families = [
        {"产品定位", "定位", "主打", "面向", "场景"},
        {"目标用户", "用户", "人群", "学生", "职场", "开发者", "企业用户", "个人用户"},
        {"核心功能", "功能", "能力", "搜索", "生成", "插件", "任务", "文件", "系统操作"},
        {"会员价格", "价格", "会员", "订阅", "Pro", "收费", "免费"},
        {"商业化方式", "商业化", "收费", "广告", "订阅"},
        {"近期更新", "更新", "发布", "上线", "新增", "近期"},
    ]
    return sum(
        1
        for family in families
        if family != current and any(keyword in sentence for keyword in family)
    )


def _top_level_sections(report: str) -> dict[str, str]:
    matches = list(re.finditer(r"(?m)^\s*(?:#{1,6}\s*)?(\d+)\.\s+(.+?)\s*$", report or ""))
    sections: dict[str, str] = {}
    for index, match in enumerate(matches):
        title = match.group(2).strip()
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(report)
        sections[title] = report[start:end].strip()
    return sections


def _section_by_hint(report: str, hints: list[str]) -> str:
    sections = _top_level_sections(report)
    for title, body in sections.items():
        if any(hint in title for hint in hints):
            return body
    return report


def _subsection_for_competitor(section: str, aliases: list[str]) -> str:
    matches = list(re.finditer(r"(?m)^\s*(?:#{1,6}\s*)?\d+\.\d+\s+(.+?)\s*$", section or ""))
    for index, match in enumerate(matches):
        title = match.group(1).strip()
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(section)
        if _contains_alias(title, aliases):
            return section[start:end].strip()
    return ""


def _subsection_by_hint(section: str, hints: list[str]) -> str:
    matches = list(re.finditer(r"(?m)^\s*(?:#{1,6}\s*)?\d+(?:\.\d+)+\s+(.+?)\s*$", section or ""))
    for index, match in enumerate(matches):
        title = match.group(1).strip()
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(section)
        if any(hint in title for hint in hints):
            return section[start:end].strip()
    return ""


def _split_markdown_row(row: str) -> list[str]:
    stripped = row.strip().strip("|")
    return [cell.strip() for cell in stripped.split("|")]


def _is_separator_row(cells: list[str]) -> bool:
    return bool(cells) and all(re.fullmatch(r":?-{3,}:?", cell.strip()) for cell in cells)


def _extract_tables(text: str) -> list[list[list[str]]]:
    tables: list[list[list[str]]] = []
    current: list[list[str]] = []

    for line in (text or "").splitlines():
        if line.strip().startswith("|") and line.strip().endswith("|"):
            cells = _split_markdown_row(line)
            if not _is_separator_row(cells):
                current.append(cells)
        elif current and not line.strip():
            continue
        elif current:
            if len(current) >= 2:
                tables.append(current)
            current = []

    if len(current) >= 2:
        tables.append(current)
    return tables


def _table_column_summary(section: str, aliases: list[str]) -> str:
    for table in _extract_tables(section):
        header = table[0]
        column_index = next(
            (
                index
                for index, name in enumerate(header)
                if _contains_alias(name, aliases) or any(name and name in alias for alias in aliases)
            ),
            None,
        )
        if column_index is None:
            continue

        summaries = []
        for row in table[1:]:
            if len(row) <= column_index:
                continue
            label = row[0] if row else ""
            value = row[column_index]
            if label and value:
                summaries.append(f"{label}：{value}")
            if len(summaries) >= 4:
                break
        if summaries:
            return "；".join(summaries)
    return ""


def _table_row_summary(section: str, aliases: list[str]) -> str:
    for table in _extract_tables(section):
        header = table[0]
        for row in table[1:]:
            if not row or not _contains_alias(row[0], aliases):
                continue
            cells = []
            for index, cell in enumerate(row[1:], start=1):
                label = header[index] if index < len(header) else f"字段{index}"
                if cell:
                    cells.append(f"{label}：{cell}")
            if cells:
                return "；".join(cells)
    return ""


def _dimension_section_hints(dimension: str) -> list[str]:
    if "定位" in dimension or "用户" in dimension:
        return ["产品定位与目标用户"]
    if "功能" in dimension:
        return ["核心功能对比矩阵", "核心功能"]
    if "会员" in dimension or "商业" in dimension or "定价" in dimension:
        return ["定价与商业化方式", "商业化"]
    if "更新" in dimension:
        return ["近期产品更新", "近期更新"]
    return [dimension]


def _targeted_evidence(report: str, competitor: str, dimension: str, aliases: list[str] | None = None) -> str:
    aliases = aliases or _competitor_aliases(competitor)
    section = _section_by_hint(report, _dimension_section_hints(dimension))

    if "功能" in dimension:
        return _table_column_summary(section, aliases)

    if "会员" in dimension:
        member_section = _subsection_by_hint(section, ["会员体系", "会员"])
        return _table_row_summary(member_section, aliases) or _table_row_summary(section, aliases)

    if "商业" in dimension or "定价" in dimension:
        commission_section = _subsection_by_hint(section, ["商家佣金", "佣金"])
        return _table_row_summary(commission_section, aliases) or _table_row_summary(section, aliases)

    competitor_section = _subsection_for_competitor(section, aliases)
    if competitor_section:
        lines = [line.strip() for line in competitor_section.splitlines() if line.strip()]
        if "定位" in dimension:
            matched = [line for line in lines if line.startswith("产品定位")]
        elif "用户" in dimension:
            matched = [line for line in lines if line.startswith("目标用户")]
        else:
            matched = [line for line in lines if _count_matches(line, aliases) or re.search(r"\d{4}年", line)]
        if matched:
            return " ".join(matched[:3])

    return ""


def _find_evidence(
    report: str,
    competitor: str,
    dimension: str,
    aliases: list[str] | None = None,
) -> list[dict[str, Any]]:
    aliases = aliases or _competitor_aliases(competitor)
    targeted = _targeted_evidence(report, competitor, dimension, aliases)
    if targeted:
        return [{
            "snippet": targeted[:240],
            "urls": extract_urls(targeted),
        }]

    dimension_keywords = [dimension]
    if "价格" in dimension or "会员" in dimension:
        dimension_keywords.extend(["价格", "会员", "订阅", "Pro", "收费", "免费"])
    if "功能" in dimension:
        dimension_keywords.extend(["功能", "能力", "搜索", "生成", "插件"])
    if "定位" in dimension:
        dimension_keywords.extend(["定位", "主打", "面向", "场景"])
    if "用户" in dimension:
        dimension_keywords.extend(["用户", "人群", "学生", "职场", "开发者"])
    if "更新" in dimension:
        dimension_keywords.extend(["更新", "发布", "上线", "新增", "近期"])
    if "商业" in dimension:
        dimension_keywords.extend(["商业化", "收费", "会员", "广告", "订阅"])

    evidence = []
    for sentence in _extract_sentences(report):
        if not _contains_alias(sentence, aliases):
            continue
        if _is_generic_research_scope_sentence(sentence):
            continue
        if "研究范围" in sentence or "围绕" in sentence:
            continue
        if sentence.startswith("|") and ("维度" in sentence or "平台" in sentence):
            continue
        if _count_matches(sentence, aliases) >= 2 and _count_matches(sentence, dimension_keywords) >= 2:
            continue
        if _other_dimension_match_count(sentence, dimension) >= 2:
            continue
        if not any(keyword and keyword in sentence for keyword in dimension_keywords):
            continue
        evidence.append({
            "snippet": sentence[:240],
            "urls": extract_urls(sentence),
        })
        if len(evidence) >= 3:
            break
    return evidence


def build_competitive_matrix(request: dict[str, Any], report: str) -> dict[str, Any]:
    competitors = request.get("competitors") or []
    dimensions = request.get("dimensions") or []
    alias_map = request.get("competitor_aliases") or {}
    rows = []

    for competitor in competitors:
        aliases = alias_map.get(competitor) or _competitor_aliases(competitor)
        cells = {}
        for dimension in dimensions:
            evidence = _find_evidence(report, competitor, dimension, aliases)
            cells[dimension] = {
                "status": "found" if evidence else "missing",
                "evidence": evidence,
                "summary": evidence[0]["snippet"] if evidence else "暂未从报告中提取到明确证据",
            }
        rows.append({
            "competitor": competitor,
            "cells": cells,
        })

    total_cells = max(len(competitors) * len(dimensions), 1)
    found_cells = sum(
        1
        for row in rows
        for cell in row["cells"].values()
        if cell["status"] == "found"
    )

    return {
        "competitors": competitors,
        "dimensions": dimensions,
        "rows": rows,
        "coverage": {
            "total_cells": total_cells,
            "found_cells": found_cells,
            "coverage_rate": round(found_cells / total_cells, 4),
        },
        "notes": [
            "This is a deterministic baseline matrix extracted from the final report text.",
            "A missing cell means no sentence matched both competitor and dimension keywords; it does not prove the information is absent from all sources.",
        ],
    }


def extract_intermediate_results(log_path: str | None, task: str, report: str) -> dict[str, Any]:
    events = []
    if log_path and os.path.exists(log_path):
        try:
            with open(log_path, "r", encoding="utf-8") as f:
                payload = json.load(f)
            events = payload.get("events") or []
        except Exception:
            events = []

    sub_queries = []
    source_urls = []
    images = []
    agent_metadata = None
    semantic_metadata = None
    event_counts: dict[str, int] = {}

    for event in events:
        data = event.get("data") or {}
        content = data.get("content") or data.get("type") or "unknown"
        event_counts[content] = event_counts.get(content, 0) + 1

        if content == "subqueries" and isinstance(data.get("metadata"), list):
            sub_queries.extend(str(item) for item in data["metadata"] if str(item).strip())
        elif content == "added_source_url" and data.get("metadata"):
            source_urls.append(str(data["metadata"]))
        elif content == "scraping_images" and isinstance(data.get("metadata"), list):
            images.extend(str(item) for item in data["metadata"] if str(item).strip())
        elif content == "agent_repair_summary" and isinstance(data.get("metadata"), dict):
            agent_metadata = data["metadata"]
        elif content in {"semantic_validation_summary", "semantic_remediation_summary"} and isinstance(data.get("metadata"), dict):
            semantic_metadata = data["metadata"]

    if not source_urls:
        source_urls = extract_urls(report)

    seen = set()
    source_urls = filter_usable_source_urls([url for url in source_urls if not (url in seen or seen.add(url))])

    seen_queries = set()
    sub_queries = [
        query for query in sub_queries
        if query and COMPETITIVE_MARKER not in query and not (query in seen_queries or seen_queries.add(query))
    ]

    return {
        "task": task,
        "log_path": log_path or "",
        "sub_queries": sub_queries,
        "source_urls": source_urls,
        "image_urls": images,
        "event_counts": event_counts,
        "event_count": len(events),
        "report_url_count": len(extract_urls(report)),
        "agent_metadata": agent_metadata or {},
        "semantic_metadata": semantic_metadata or {},
    }


def _domain_from_url(url: str) -> str:
    try:
        return urlparse(url).netloc.lower()
    except Exception:
        return ""


def _looks_official(url: str) -> bool:
    source = build_source_tier_summary([url])["classified_urls"][0]
    return source["tier"] == "S"


def _extract_year_months(text: str) -> list[str]:
    matches = re.findall(r"(20\d{2})\s*年\s*(\d{1,2})\s*月|((?:20)\d{2})Q([1-4])", text or "")
    values = []
    for year, month, q_year, quarter in matches:
        if year and month:
            values.append(f"{year}-{int(month):02d}")
        elif q_year and quarter:
            values.append(f"{q_year}Q{quarter}")
    return values


def detect_time_scope_warnings(request: dict[str, Any], report: str) -> list[str]:
    time_range = request.get("time_range") or ""
    if "最近" not in time_range:
        return []

    warnings = []
    dates = _extract_year_months(report)
    old_2025_dates = [value for value in dates if value.startswith("2025")]
    if old_2025_dates:
        warnings.append(
            "报告包含 2025 年时间点；如果用户要求最近 6 个月，应确认这些内容是否只是背景信息，而不是近期更新。"
        )

    if "近期产品更新" in report:
        recent_section = re.search(
            r"#+\s*(?:\d+\.\s*)?近期产品更新(?P<body>.*?)(?:\n#+\s*(?:\d+\.\s*)?产品差异|\n#+\s*(?:\d+\.\s*)?市场空白|\Z)",
            report,
            flags=re.DOTALL,
        )
        if recent_section and any(value.startswith("2025") for value in _extract_year_months(recent_section.group("body"))):
            warnings.append("“近期产品更新”章节包含 2025 年信息，可能不符合最近 6 个月口径。")

    official_coverage = {}
    unknown_profiles = (official_coverage or {}).get("unknown_profile_competitors") or []
    if unknown_profiles:
        warnings.append(
            f"以下竞品未识别到官方主体/官网资料：{'、'.join(unknown_profiles)}。建议优先补充官网、母公司业务介绍、官方公告或帮助中心来源。"
        )
    return warnings


def detect_source_warnings(
    urls: list[str],
    official_like_urls: list[str],
    official_coverage: dict[str, Any] | None = None,
) -> list[str]:
    warnings = []
    if urls and not official_like_urls:
        warnings.append("未识别到官方倾向 URL，关键事实可能过度依赖第三方来源。")
    elif urls and len(official_like_urls) / len(urls) < 0.25:
        warnings.append("官方倾向 URL 占比低于 25%，建议补充官网、官方公告、帮助中心、定价页或母公司业务介绍。")

    missing_competitors = (official_coverage or {}).get("missing_competitors") or []
    if missing_competitors:
        warnings.append(
            f"以下竞品缺少可识别官方来源：{'、'.join(missing_competitors)}。建议补充官网、财报、官方公告或帮助中心来源。"
        )
    unknown_profiles = (official_coverage or {}).get("unknown_profile_competitors") or []
    if unknown_profiles:
        warnings.append(
            f"以下竞品未识别到官方主体/官网资料：{'、'.join(unknown_profiles)}。建议优先补充官网、母公司业务介绍、官方公告或帮助中心来源。"
        )
    return warnings


def _urls_from_trace_payload(payload: Any) -> list[str]:
    urls = []
    if isinstance(payload, dict):
        for key in ("url", "href", "source_url"):
            if payload.get(key):
                urls.append(str(payload[key]))
        value = payload.get("urls")
        if isinstance(value, list):
            urls.extend(str(item) for item in value)
        for value in payload.values():
            if isinstance(value, (dict, list)):
                urls.extend(_urls_from_trace_payload(value))
    elif isinstance(payload, list):
        for item in payload:
            urls.extend(_urls_from_trace_payload(item))
    return urls


def _process_urls_from_metadata(
    intermediate_results: dict[str, Any] | None,
    agent_data: dict[str, Any],
    semantic_data: dict[str, Any],
) -> list[str]:
    urls = []
    if intermediate_results:
        urls.extend(str(url) for url in intermediate_results.get("source_urls") or [])
    urls.extend(_urls_from_trace_payload(agent_data.get("agent_trace") or {}))
    urls.extend(_urls_from_trace_payload(agent_data.get("repair_outcome") or {}))
    urls.extend(_urls_from_trace_payload(semantic_data.get("semantic_remediation") or agent_data.get("semantic_remediation") or {}))
    return filter_usable_source_urls(urls)


def _has_report_section(report: str, section: str) -> bool:
    pattern = rf"(^|\n)\s*(?:#+\s*)?(?:\d+\.\s*)?{re.escape(section)}\s*($|\n)"
    return bool(re.search(pattern, report or ""))


def analyze_competitive_report(
    task: str,
    report: str,
    intermediate_results: dict[str, Any] | None = None,
    agent_metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    agent_data = agent_metadata or (intermediate_results or {}).get("agent_metadata") or {}
    semantic_data = (intermediate_results or {}).get("semantic_metadata") or {}
    request = extract_competitive_request(task)
    normalization = agent_data.get("competitor_normalization") or {}
    if normalization.get("normalized_competitors"):
        request = {
            **request,
            "competitors": normalization.get("normalized_competitors") or request.get("competitors") or [],
            "competitor_aliases": normalization.get("competitor_aliases") or request.get("competitor_aliases") or {},
        }
    urls = filter_usable_source_urls([
        *extract_urls(report),
        *_process_urls_from_metadata(intermediate_results, agent_data, semantic_data),
    ])
    present_sections = [section for section in REQUIRED_REPORT_SECTIONS if _has_report_section(report, section)]
    missing_sections = [
        section for section in REQUIRED_REPORT_SECTIONS
        if section not in present_sections
    ]
    official_like_urls = [url for url in urls if _looks_official(url)]
    source_tiers = build_source_tier_summary(urls)
    official_coverage = competitor_official_coverage(request, urls)
    source_warnings = detect_source_warnings(urls, official_like_urls, official_coverage)
    time_scope_warnings = detect_time_scope_warnings(request, report)

    matrix = build_competitive_matrix(request, report)
    semantic_validation = (
        semantic_data.get("semantic_validation")
        or agent_data.get("semantic_validation")
        or build_semantic_validation(report, matrix, agent_data.get("evidence_ledger") or [])
    )
    reading_context = build_reading_context(request, report, semantic_validation)

    return {
        "generated_at": datetime.now().isoformat(),
        "request": request,
        "intermediate_results": intermediate_results or extract_intermediate_results(None, task, report),
        "competitive_matrix": matrix,
        "agent_trace": agent_data.get("agent_trace") or {},
        "gap_evaluation": agent_data.get("gap_evaluation") or {},
        "initial_gap_evaluation": agent_data.get("initial_gap_evaluation") or {},
        "final_gap_evaluation": agent_data.get("final_gap_evaluation") or {},
        "repair_outcome": agent_data.get("repair_outcome") or {},
        "evidence_ledger": agent_data.get("evidence_ledger") or [],
        "repair_actions": agent_data.get("repair_actions") or [],
        "repair_context_chars": agent_data.get("repair_context_chars", 0),
        "repaired_source_count": agent_data.get("repaired_source_count", 0),
        "competitor_normalization": normalization,
        "semantic_validation": semantic_validation,
        "reading_context": reading_context,
        "semantic_remediation": semantic_data.get("semantic_remediation") or agent_data.get("semantic_remediation") or {},
        "semantic_revalidation": semantic_data.get("semantic_revalidation") or agent_data.get("semantic_revalidation") or {},
        "required_sections": REQUIRED_REPORT_SECTIONS,
        "present_sections": present_sections,
        "missing_sections": missing_sections,
        "section_completion_rate": round(len(present_sections) / len(REQUIRED_REPORT_SECTIONS), 4),
        "source_count": len(urls),
        "official_like_source_count": len(official_like_urls),
        "official_like_source_rate": round(len(official_like_urls) / len(urls), 4) if urls else 0,
        "source_tiers": source_tiers,
        "official_source_coverage": official_coverage,
        "urls": urls,
        "official_like_urls": official_like_urls,
        "source_warnings": source_warnings,
        "time_scope_warnings": time_scope_warnings,
        "notes": [
            "official_like_source_count is a heuristic based on URL/domain keywords, not a final credibility judgment.",
            "Citation matching and fact accuracy still require manual sampling in evaluation.",
        ],
    }


def collect_competitive_metadata(researcher: Any | None) -> dict[str, Any]:
    metadata: dict[str, Any] = {}
    if researcher is None:
        return metadata
    metadata.update(getattr(researcher, "competitive_normalization_metadata", {}) or {})
    metadata.update(getattr(researcher, "competitive_agent_metadata", {}) or {})
    metadata.update(getattr(researcher, "competitive_semantic_metadata", {}) or {})
    return metadata


async def save_competitive_analysis(
    task: str,
    report: str,
    filename: str,
    log_path: str | None = None,
    agent_metadata: dict[str, Any] | None = None,
) -> tuple[str, dict[str, Any]] | tuple[None, None]:
    if not is_competitive_research_task(task):
        return None, None

    os.makedirs("outputs", exist_ok=True)
    intermediate_results = extract_intermediate_results(log_path, task, report)
    analysis = analyze_competitive_report(task, report, intermediate_results, agent_metadata)
    output_path = os.path.join("outputs", f"{filename}_competitive_analysis.json")
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(analysis, f, ensure_ascii=False, indent=2)
    return output_path, analysis
