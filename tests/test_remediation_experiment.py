from backend.server.remediation_experiment import build_strategy_metrics, compare_strategy_metrics


def test_build_strategy_metrics_tracks_remediation_outcomes():
    before = {
        "semantic_gaps": [
            {"id": "g1", "severity": "high"},
            {"id": "g2", "severity": "medium"},
        ],
        "claim_validation": [
            {"status": "unsupported"},
            {"status": "weakly_supported"},
        ],
    }
    after = {
        "semantic_gaps": [
            {"id": "g2", "severity": "medium"},
        ],
        "claim_validation": [
            {"status": "supported"},
            {"status": "weakly_supported"},
        ],
    }

    metrics = build_strategy_metrics(
        strategy="1-cycle",
        validation_before=before,
        validation_after=after,
        runtime_seconds=12.5,
        llm_calls=2,
        search_calls=1,
        rewritten_sections=1,
    )

    assert metrics["unsupported_fixed_count"] == 1
    assert metrics["semantic_gap_fixed_rate"] == 0.5
    assert metrics["runtime_seconds"] == 12.5
    assert metrics["rewritten_sections"] == 1


def test_compare_strategy_metrics_ranks_by_quality_then_cost():
    records = [
        {
            "strategy": "2-cycle",
            "semantic_gap_fixed_rate": 0.5,
            "unsupported_after": 1,
            "runtime_seconds": 40,
            "llm_calls": 5,
            "search_calls": 3,
        },
        {
            "strategy": "1-cycle",
            "semantic_gap_fixed_rate": 0.5,
            "unsupported_after": 1,
            "runtime_seconds": 20,
            "llm_calls": 3,
            "search_calls": 1,
        },
    ]

    comparison = compare_strategy_metrics(records)

    assert comparison["recommended_strategy"] == "1-cycle"


def test_build_strategy_metrics_does_not_treat_regenerated_gap_ids_as_fixed():
    before = {
        "semantic_gaps": [{"id": "old_1"}, {"id": "old_2"}],
        "claim_validation": [{"status": "unsupported"}, {"status": "unsupported"}],
    }
    after = {
        "semantic_gaps": [{"id": "new_1"}, {"id": "new_2"}, {"id": "new_3"}],
        "claim_validation": [{"status": "unsupported"}, {"status": "unsupported"}, {"status": "unsupported"}],
    }

    metrics = build_strategy_metrics("post-only", before, after)

    assert metrics["unsupported_fixed_count"] == 0
    assert metrics["semantic_gap_fixed_rate"] == 0.0
