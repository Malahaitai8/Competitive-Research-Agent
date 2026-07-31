import asyncio
import os
import re
from typing import Any

import json_repair

from gpt_researcher.actions.utils import stream_output
from gpt_researcher.competitive_sources import official_terms_for_competitor
from gpt_researcher.llm_provider.generic.base import ReasoningEfforts
from gpt_researcher.utils.llm import create_chat_completion

from .competitive_research import build_competitive_matrix, extract_competitive_request, is_competitive_research_task
from .progress_events import make_progress_event
from .semantic_validation import plan_remediation_actions, run_semantic_validator


RISK_SECTION_TITLE = "\u8bed\u4e49\u6821\u9a8c\u4e0e\u5f85\u786e\u8ba4\u98ce\u9669"


def get_semantic_remediation_config(mode: str | None = None, max_cycles: int | None = None) -> dict[str, Any]:
    mode_value = (mode or os.getenv("COMPETITIVE_SEMANTIC_REMEDIATION_MODE") or "1-cycle").strip().lower()
    aliases = {
        "0": "0-cycle",
        "zero": "0-cycle",
        "none": "0-cycle",
        "off": "0-cycle",
        "1": "1-cycle",
        "one": "1-cycle",
        "2": "2-cycle",
        "two": "2-cycle",
        "pre_only": "pre-only",
        "post_only": "post-only",
    }
    normalized = aliases.get(mode_value, mode_value)
    defaults = {
        "0-cycle": 0,
        "1-cycle": 1,
        "2-cycle": 2,
        "pre-only": 0,
        "post-only": 1,
    }
    if normalized not in defaults:
        normalized = "1-cycle"
    cycle_count = defaults[normalized] if max_cycles is None else max(0, int(max_cycles))
    return {"mode": normalized, "max_cycles": cycle_count}


def should_run_automatic_semantic_repair(
    validation: dict[str, Any],
    cycle_budget: int,
) -> bool:
    """Keep bounded repair enabled whenever the validator finds a gap."""
    gap_count = len(validation.get("semantic_gaps") or [])
    return cycle_budget > 0 and gap_count > 0


def build_semantic_repair_calls(task: str, actions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    calls = []
    seen = set()
    for action in actions:
        if action.get("action") != "search_and_rewrite":
            continue
        query = build_semantic_repair_query(task, action)
        if not query:
            continue
        if query in seen:
            continue
        seen.add(query)
        calls.append({
            "tool": "repair_search",
            "arguments": {
                "query": query,
                "gap_ids": [str(action.get("gap_id") or action.get("id") or "semantic_gap")],
            },
            "reason": "\u8bed\u4e49\u6821\u9a8c\u53d1\u73b0\u5173\u952e\u7ed3\u8bba\u7f3a\u5c11\u8bc1\u636e\u652f\u6491\uff0c\u9700\u8981\u53d7\u63a7\u8865\u641c\u540e\u91cd\u5199\u3002",
        })
    return calls


def _compact_query_text(text: str, limit: int = 80) -> str:
    clean = re.sub(r"https?://\S+", "", text or "")
    clean = re.sub(r"\[[^\]]+\]\([^)]+\)", "", clean)
    clean = re.sub(r"[|；;，,。]+", " ", clean)
    clean = re.sub(r"\s+", " ", clean).strip()
    return clean[:limit].strip()


def build_semantic_repair_query(task: str, action: dict[str, Any]) -> str:
    request = extract_competitive_request(task)
    location = action.get("location") or {}
    competitor = str(location.get("competitor") or "").strip()
    dimension = str(location.get("dimension") or "").strip()
    section = str(location.get("section") or "").strip()
    claim = str(action.get("claim") or "").strip()

    if competitor:
        dimension_text = dimension or _compact_query_text(section or claim, 16) or "竞品研究"
        official_terms = official_terms_for_competitor(competitor, request)
        return _compact_query_text(f"{competitor} {dimension_text} {official_terms} 官方 来源", 80)

    topic = str(request.get("research_topic") or "").strip()
    claim_terms = _compact_query_text(section or claim, 32)
    if topic or claim_terms:
        return _compact_query_text(f"{topic} {claim_terms} 官方 来源 定价 更新", 80)
    return ""


def _validation_summary(validation: dict[str, Any]) -> dict[str, int]:
    summary = validation.get("summary") or {}
    if summary:
        return {
            "semantic_gap_count": int(summary.get("semantic_gap_count") or len(validation.get("semantic_gaps") or [])),
            "unsupported": int(summary.get("unsupported") or 0),
            "weakly_supported": int(summary.get("weakly_supported") or 0),
            "needs_human_review": int(summary.get("needs_human_review") or 0),
        }
    items = [
        *(validation.get("matrix_validation") or []),
        *(validation.get("claim_validation") or []),
    ]
    return {
        "semantic_gap_count": len(validation.get("semantic_gaps") or []),
        "unsupported": sum(1 for item in items if item.get("status") == "unsupported"),
        "weakly_supported": sum(1 for item in items if item.get("status") == "weakly_supported"),
        "needs_human_review": sum(1 for item in items if item.get("status") == "needs_human_review"),
    }


def decide_remediation_outcome(before_validation: dict[str, Any], after_validation: dict[str, Any]) -> dict[str, Any]:
    before = _validation_summary(before_validation)
    after = _validation_summary(after_validation)
    unsupported_delta = after["unsupported"] - before["unsupported"]
    gap_delta = after["semantic_gap_count"] - before["semantic_gap_count"]
    weak_delta = after["weakly_supported"] - before["weakly_supported"]
    human_delta = after["needs_human_review"] - before["needs_human_review"]
    net_improvement = (
        max(before["unsupported"] - after["unsupported"], 0) * 3
        + max(before["semantic_gap_count"] - after["semantic_gap_count"], 0) * 2
        + max(before["weakly_supported"] - after["weakly_supported"], 0)
    )

    if unsupported_delta > 0 or gap_delta > 0:
        decision = "rollback"
    elif net_improvement > 0 and human_delta <= 0:
        decision = "accept"
    else:
        decision = "neutral"

    return {
        "decision": decision,
        "before": before,
        "after": after,
        "unsupported_delta": unsupported_delta,
        "semantic_gap_delta": gap_delta,
        "weakly_supported_delta": weak_delta,
        "needs_human_review_delta": human_delta,
        "net_improvement": net_improvement,
    }


def prepare_rewrite_actions(
    actions: list[dict[str, Any]],
    repair_context: str,
    repaired_sources: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    has_new_evidence = bool(str(repair_context or "").strip()) or bool(repaired_sources)
    prepared: list[dict[str, Any]] = []
    for action in actions:
        copied = dict(action)
        if copied.get("action") == "search_and_rewrite" and not has_new_evidence:
            copied["action"] = "risk_only"
            copied["tool"] = "semantic_risk_annotation"
            copied["downgrade_reason"] = "no_new_evidence"
        prepared.append(copied)
    return prepared


def apply_risk_annotations(report: str, validation: dict[str, Any]) -> str:
    # Keep semantic validation details in metadata/progress only. Appending raw
    # validator gaps to the Markdown report mixes internal QA with user-facing
    # conclusions and makes the final report harder to trust.
    return report


def _rewrite_excerpts(report: str, actions: list[dict[str, Any]]) -> str:
    excerpts: list[str] = []
    seen = set()
    for action in actions:
        claim = str(action.get("claim") or "").strip()
        location = action.get("location") or {}
        section = str(location.get("section") or "").strip()
        needle = claim if claim and claim in report else section
        if not needle or needle not in report:
            continue
        start = max(report.find(needle) - 320, 0)
        end = min(report.find(needle) + len(needle) + 320, len(report))
        excerpt = report[start:end].strip()
        if excerpt and excerpt not in seen:
            seen.add(excerpt)
            excerpts.append(excerpt)
    return "\n\n---\n\n".join(excerpts)[:6000]


def _apply_rewrite_patches(report: str, payload: Any) -> str:
    if not isinstance(payload, dict):
        return report
    updated = report
    for patch in payload.get("patches") or []:
        if not isinstance(patch, dict):
            continue
        original = str(patch.get("original") or "").strip()
        replacement = str(patch.get("replacement") or "").strip()
        if not original or not replacement or original == replacement:
            continue
        if original in updated:
            updated = updated.replace(original, replacement, 1)
    return updated


async def _rewrite_report_with_actions(researcher, report: str, actions: list[dict[str, Any]], extra_context: str) -> str:
    if not actions:
        return report
    excerpts = _rewrite_excerpts(report, actions)
    prompt = f"""You are an editor for a Chinese competitive research report.
Only use the provided evidence and remediation actions. Return small exact-text patches for affected sentences or matrix cells.
Do not add unsupported conclusions. If evidence remains insufficient, explicitly mark it as pending human confirmation.
For weakly supported claims, make the wording more cautious instead of making the conclusion stronger.
For risk_only actions, do not invent replacement facts; only add a concise risk note where the claim appears.
Do not rewrite the complete report.

Remediation actions:
{actions}

Evidence:
{extra_context[:8000]}

Affected report excerpts:
{excerpts}

Return only JSON in this shape:
{{"patches":[{{"original":"exact text copied from the excerpt","replacement":"revised Chinese text"}}]}}
The original text must match the excerpt exactly."""
    try:
        rewritten = await asyncio.wait_for(
            create_chat_completion(
                model=researcher.cfg.strategic_llm_model,
                messages=[{"role": "user", "content": prompt}],
                llm_provider=researcher.cfg.strategic_llm_provider,
                max_tokens=min(int(researcher.cfg.strategic_token_limit), 2500),
                llm_kwargs=researcher.cfg.llm_kwargs,
                reasoning_effort=ReasoningEfforts.Low.value,
                cost_callback=researcher.add_costs,
                **researcher.kwargs,
            ),
            timeout=90,
        )
        return _apply_rewrite_patches(report, json_repair.loads(rewritten))
    except Exception:
        return report


async def run_competitive_semantic_remediation(
    researcher,
    task: str,
    report: str,
    max_cycles: int | None = None,
    mode: str | None = None,
) -> tuple[str, dict[str, Any]]:
    if not is_competitive_research_task(task):
        return report, {}

    from .agent_repair import build_evidence_ledger, execute_repair_tool_calls

    config = get_semantic_remediation_config(mode, max_cycles)
    cycle_budget = int(config["max_cycles"])
    agent_metadata = getattr(researcher, "competitive_agent_metadata", {}) or {}
    evidence_ledger = agent_metadata.get("evidence_ledger") or []
    request = extract_competitive_request(task)

    validation = await run_semantic_validator(
        report,
        build_competitive_matrix(request, report),
        evidence_ledger,
        _llm_call_for(researcher),
    )

    await stream_output(
        **make_progress_event(
            "semantic_validation_summary",
            f"Semantic validation completed: {len(validation.get('semantic_gaps') or [])} semantic gap(s).",
            raw_message="Semantic validation completed",
            stage="semantic_validation",
            status="completed",
            severity="warning" if validation.get("semantic_gaps") else "info",
            metadata={"semantic_validation": validation},
        ),
        websocket=researcher.websocket,
        output_log=True,
    )

    initial_actions = plan_remediation_actions(validation)
    automatic_repair_enabled = should_run_automatic_semantic_repair(
        validation,
        cycle_budget,
    )
    if not automatic_repair_enabled or not initial_actions:
        final_report = apply_risk_annotations(report, validation)
        remediation = {
            "mode": config["mode"],
            "max_cycles": cycle_budget,
            "cycles_executed": 0,
            "actions": initial_actions,
            "repair_calls": [],
            "executed_calls": [],
            "repaired_source_count": 0,
            "rewritten": final_report != report,
            "skip_reason": "no_automatic_repair_needed",
        }
        metadata = {
            "semantic_validation": validation,
            "semantic_remediation": remediation,
            "semantic_revalidation": validation,
            "evidence_ledger": evidence_ledger,
        }
        researcher.competitive_semantic_metadata = metadata
        return final_report, metadata

    current_report = report
    current_validation = validation
    updated_evidence_ledger = evidence_ledger
    all_actions: list[dict[str, Any]] = []
    all_repair_calls: list[dict[str, Any]] = []
    all_executed_calls: list[dict[str, Any]] = []
    all_repaired_sources: list[dict[str, Any]] = []
    cycle_records: list[dict[str, Any]] = []
    cycles_executed = 0

    for cycle_index in range(1, cycle_budget + 1):
        cycle_actions = plan_remediation_actions(current_validation)
        if not cycle_actions:
            break

        cycles_executed = cycle_index
        previous_report = current_report
        previous_validation = current_validation
        previous_evidence_ledger = updated_evidence_ledger
        repair_calls = build_semantic_repair_calls(task, cycle_actions)
        all_repair_calls.extend(repair_calls)

        repair_context = ""
        repaired_sources: list[dict[str, Any]] = []
        executed_calls: list[dict[str, Any]] = []
        if repair_calls:
            repair_context, repaired_sources, executed_calls = await execute_repair_tool_calls(researcher, task, repair_calls)
            all_repaired_sources.extend(repaired_sources)
            all_executed_calls.extend(executed_calls)
            if repair_context:
                researcher.context = f"{researcher.context or ''}\n\n## Semantic remediation context\n{repair_context}"
            if repaired_sources or repair_context:
                updated_evidence_ledger = build_evidence_ledger(
                    task,
                    [*researcher.get_research_sources(), *all_repaired_sources],
                    f"{researcher.context or ''}\n\n{repair_context}",
                    from_repair=True,
                )

        prepared_actions = prepare_rewrite_actions(cycle_actions, repair_context, repaired_sources)
        all_actions.extend(prepared_actions)
        rewrite_actions = [action for action in prepared_actions if action.get("action") != "risk_only"]

        if rewrite_actions:
            candidate_report = await _rewrite_report_with_actions(
                researcher,
                current_report,
                prepared_actions,
                f"{researcher.context or ''}\n\n{repair_context}",
            )
            candidate_validation = await run_semantic_validator(
                candidate_report,
                build_competitive_matrix(request, candidate_report),
                updated_evidence_ledger,
                _llm_call_for(researcher),
            )
        else:
            candidate_report = current_report
            candidate_validation = current_validation

        outcome = decide_remediation_outcome(current_validation, candidate_validation)
        if outcome["decision"] == "rollback":
            current_report = previous_report
            current_validation = previous_validation
            updated_evidence_ledger = previous_evidence_ledger
        else:
            current_report = candidate_report
            current_validation = candidate_validation

        cycle_records.append({
            "cycle": cycle_index,
            "actions": prepared_actions,
            "repair_call_count": len(repair_calls),
            "executed_call_count": len(executed_calls),
            "rewrite_action_count": len(rewrite_actions),
            "decision": outcome["decision"],
            "outcome": outcome,
            "semantic_gap_count_after": len(current_validation.get("semantic_gaps") or []),
        })
        if outcome["decision"] == "rollback":
            break
        if not current_validation.get("semantic_gaps"):
            break
        if not rewrite_actions:
            break
        if outcome["decision"] == "neutral" and not executed_calls:
            break

    final_report = apply_risk_annotations(current_report, current_validation)
    accepted_cycles = sum(1 for record in cycle_records if record.get("decision") == "accept")
    neutral_cycles = sum(1 for record in cycle_records if record.get("decision") == "neutral")
    rolled_back_cycles = sum(1 for record in cycle_records if record.get("decision") == "rollback")
    remediation = {
        "mode": config["mode"],
        "max_cycles": cycle_budget,
        "cycles_executed": cycles_executed,
        "cycles": cycle_records,
        "accepted_cycles": accepted_cycles,
        "neutral_cycles": neutral_cycles,
        "rolled_back_cycles": rolled_back_cycles,
        "actions": all_actions,
        "repair_calls": all_repair_calls,
        "executed_calls": all_executed_calls,
        "repaired_source_count": len(all_repaired_sources),
        "rewritten": final_report != report,
    }
    metadata = {
        "semantic_validation": validation,
        "semantic_remediation": remediation,
        "semantic_revalidation": current_validation,
        "evidence_ledger": updated_evidence_ledger,
    }
    researcher.competitive_semantic_metadata = metadata

    await stream_output(
        **make_progress_event(
            "semantic_remediation_summary",
            f"Semantic remediation completed: {len(all_actions)} controlled action(s).",
            raw_message="Semantic remediation completed",
            stage="semantic_remediation",
            status="completed",
            severity="warning" if current_validation.get("semantic_gaps") else "info",
            metadata=metadata,
        ),
        websocket=researcher.websocket,
        output_log=True,
    )
    return final_report, metadata


def _llm_call_for(researcher):
    async def call(prompt: str) -> str:
        try:
            timeout_seconds = float(
                os.getenv("SEMANTIC_VALIDATION_TIMEOUT_SECONDS", "90")
            )
        except ValueError:
            timeout_seconds = 90.0
        return await asyncio.wait_for(
            create_chat_completion(
                model=researcher.cfg.fast_llm_model,
                messages=[{"role": "user", "content": prompt}],
                llm_provider=researcher.cfg.fast_llm_provider,
                max_tokens=min(int(researcher.cfg.fast_token_limit), 3000),
                llm_kwargs=researcher.cfg.llm_kwargs,
                reasoning_effort=ReasoningEfforts.Low.value,
                cost_callback=researcher.add_costs,
                **researcher.kwargs,
            ),
            timeout=max(timeout_seconds, 0.01),
        )
    return call
