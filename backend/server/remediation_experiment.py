from typing import Any


def _count_status(validation: dict[str, Any], status: str) -> int:
    items = [
        *(validation.get("matrix_validation") or []),
        *(validation.get("claim_validation") or []),
    ]
    return sum(1 for item in items if item.get("status") == status)


def build_strategy_metrics(
    strategy: str,
    validation_before: dict[str, Any],
    validation_after: dict[str, Any],
    runtime_seconds: float = 0.0,
    llm_calls: int = 0,
    search_calls: int = 0,
    scrape_calls: int = 0,
    rewritten_sections: int = 0,
    added_sources: int = 0,
    duplicate_sources: int = 0,
    new_error_count: int = 0,
) -> dict[str, Any]:
    before_count = len(validation_before.get("semantic_gaps") or [])
    after_count = len(validation_after.get("semantic_gaps") or [])
    fixed_count = max(before_count - after_count, 0)
    unsupported_before = _count_status(validation_before, "unsupported")
    unsupported_after = _count_status(validation_after, "unsupported")
    return {
        "strategy": strategy,
        "semantic_gap_before": before_count,
        "semantic_gap_after": after_count,
        "unsupported_before": unsupported_before,
        "unsupported_after": unsupported_after,
        "weakly_supported_before": _count_status(validation_before, "weakly_supported"),
        "weakly_supported_after": _count_status(validation_after, "weakly_supported"),
        "unsupported_fixed_count": max(unsupported_before - unsupported_after, 0),
        "semantic_gap_fixed_rate": round(fixed_count / before_count, 4) if before_count else 0.0,
        "runtime_seconds": runtime_seconds,
        "llm_calls": llm_calls,
        "search_calls": search_calls,
        "scrape_calls": scrape_calls,
        "rewritten_sections": rewritten_sections,
        "added_sources": added_sources,
        "duplicate_sources": duplicate_sources,
        "new_error_count": new_error_count,
    }


def compare_strategy_metrics(records: list[dict[str, Any]]) -> dict[str, Any]:
    if not records:
        return {"recommended_strategy": "", "records": []}
    ranked = sorted(
        records,
        key=lambda item: (
            -float(item.get("semantic_gap_fixed_rate") or 0),
            int(item.get("unsupported_after") or 0),
            float(item.get("runtime_seconds") or 0),
            int(item.get("llm_calls") or 0),
            int(item.get("search_calls") or 0),
        ),
    )
    return {
        "recommended_strategy": ranked[0].get("strategy", ""),
        "records": records,
        "ranking": [item.get("strategy", "") for item in ranked],
    }
