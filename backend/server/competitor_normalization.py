import json
import re
from typing import Any

from gpt_researcher.actions.utils import stream_output
from gpt_researcher.llm_provider.generic.base import ReasoningEfforts
from gpt_researcher.utils.llm import create_chat_completion

from .competitive_research import COMPETITIVE_MARKER, extract_competitive_request, is_competitive_research_task
from .progress_events import make_progress_event


MIN_NORMALIZATION_CONFIDENCE = 0.75


def _extract_json_object(text: str) -> dict[str, Any]:
    try:
        return json.loads(text)
    except Exception:
        pass

    match = re.search(r"\{.*\}", text or "", flags=re.DOTALL)
    if not match:
        return {}
    try:
        return json.loads(match.group(0))
    except Exception:
        return {}


def parse_competitor_normalization_response(
    response: str,
    original_competitors: list[str],
    min_confidence: float = MIN_NORMALIZATION_CONFIDENCE,
) -> dict[str, Any]:
    payload = _extract_json_object(response)
    items = payload.get("competitors") if isinstance(payload, dict) else []
    if not isinstance(items, list):
        items = []

    by_original: dict[str, dict[str, Any]] = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        original = str(item.get("original_name") or "").strip()
        if original not in original_competitors:
            continue
        canonical = str(item.get("canonical_name") or original).strip() or original
        try:
            confidence = float(item.get("confidence"))
        except Exception:
            confidence = 0.0
        aliases = [
            str(alias).strip()
            for alias in item.get("aliases", [])
            if str(alias).strip()
        ]
        accepted = confidence >= min_confidence and bool(canonical)
        final_name = canonical if accepted else original
        by_original[original] = {
            "original_name": original,
            "canonical_name": final_name,
            "model_canonical_name": canonical,
            "aliases": list(dict.fromkeys([final_name, original, *aliases])),
            "confidence": confidence,
            "accepted": accepted,
            "reason": str(item.get("reason") or ""),
        }

    normalized_competitors: list[str] = []
    competitor_aliases: dict[str, list[str]] = {}
    ambiguous_items: list[dict[str, Any]] = []
    for original in original_competitors:
        item = by_original.get(original) or {
            "original_name": original,
            "canonical_name": original,
            "model_canonical_name": original,
            "aliases": [original],
            "confidence": 0.0,
            "accepted": False,
            "reason": "missing_from_model_output",
        }
        canonical = item["canonical_name"]
        if canonical not in normalized_competitors:
            normalized_competitors.append(canonical)
            competitor_aliases[canonical] = []
        competitor_aliases[canonical].extend(item["aliases"])
        if not item["accepted"]:
            ambiguous_items.append(item)

    competitor_aliases = {
        name: list(dict.fromkeys([alias for alias in aliases if alias]))
        for name, aliases in competitor_aliases.items()
    }
    return {
        "original_competitors": original_competitors,
        "normalized_competitors": normalized_competitors,
        "competitor_aliases": competitor_aliases,
        "items": list(by_original.values()),
        "ambiguous_items": ambiguous_items,
    }


def rewrite_competitive_task_competitors(task: str, competitors: list[str]) -> str:
    if not is_competitive_research_task(task) or not competitors:
        return task
    competitor_text = "\u3001".join(competitors)
    replacement = f"\u7ade\u54c1\u8303\u56f4\uff1a{competitor_text}"
    lines = []
    replaced = False
    for line in (task or "").splitlines():
        stripped = line.strip()
        if stripped.startswith("\u7ade\u54c1\u8303\u56f4:") or stripped.startswith("\u7ade\u54c1\u8303\u56f4\uff1a"):
            lines.append(replacement)
            replaced = True
        else:
            lines.append(line)
    if not replaced:
        lines.append(replacement)
    return "\n".join(lines)


def build_competitor_normalization_prompt(task: str) -> str:
    request = extract_competitive_request(task)
    return f"""You normalize competitor names for a Chinese competitive research system.

Goal:
- Map user-provided competitor names, aliases, spelling variants, Chinese/English names, and common typos to stable canonical product/company names.
- Merge only when you are confident two names refer to the same product/company.
- Do not invent competitors.
- If uncertain, keep the original name and set confidence below 0.75.

Research request:
{json.dumps(request, ensure_ascii=False)}

Return strict JSON:
{{
  "competitors": [
    {{
      "original_name": "exact input competitor",
      "canonical_name": "stable display name",
      "aliases": ["known aliases including original spelling"],
      "confidence": 0.0,
      "reason": "short reason"
    }}
  ]
}}"""


async def normalize_competitive_task_with_llm(researcher, task: str) -> tuple[str, dict[str, Any]]:
    if not is_competitive_research_task(task):
        return task, {}

    request = extract_competitive_request(task)
    original_competitors = [str(item) for item in request.get("competitors") or [] if str(item)]
    if not original_competitors:
        return task, {}

    try:
        response = await create_chat_completion(
            model=researcher.cfg.strategic_llm_model,
            messages=[{"role": "user", "content": build_competitor_normalization_prompt(task)}],
            llm_provider=researcher.cfg.strategic_llm_provider,
            max_tokens=min(int(researcher.cfg.strategic_token_limit), 3000),
            llm_kwargs=researcher.cfg.llm_kwargs,
            reasoning_effort=ReasoningEfforts.Low.value,
            cost_callback=researcher.add_costs,
            max_attempts=2,
            request_timeout_seconds=20,
            **researcher.kwargs,
        )
        normalization = parse_competitor_normalization_response(response or "", original_competitors)
    except Exception as exc:
        normalization = {
            "original_competitors": original_competitors,
            "normalized_competitors": original_competitors,
            "competitor_aliases": {name: [name] for name in original_competitors},
            "items": [],
            "ambiguous_items": [{"error": str(exc)}],
        }

    normalized_task = rewrite_competitive_task_competitors(task, normalization["normalized_competitors"])
    metadata = {"competitor_normalization": normalization}
    researcher.competitive_normalization_metadata = metadata
    researcher.query = normalized_task

    await stream_output(
        **make_progress_event(
            "competitor_normalization",
            "\u7ade\u54c1\u540d\u79f0\u5f52\u4e00\u5b8c\u6210",
            raw_message="Competitor normalization completed",
            stage="task_parsing",
            status="completed",
            severity="warning" if normalization.get("ambiguous_items") else "info",
            metadata=metadata,
        ),
        websocket=researcher.websocket,
        output_log=True,
    )
    return normalized_task, metadata
