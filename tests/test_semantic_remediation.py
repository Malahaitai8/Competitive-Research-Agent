import asyncio

from backend.server import semantic_remediation as semantic_remediation_module
from backend.server.semantic_remediation import (
    apply_risk_annotations,
    build_semantic_repair_calls,
    decide_remediation_outcome,
    get_semantic_remediation_config,
    prepare_rewrite_actions,
)


def test_semantic_repair_calls_use_only_repair_search():
    actions = [
        {
            "gap_id": "gap_1",
            "action": "search_and_rewrite",
            "tool": "semantic_repair_search",
            "claim": "Kimi member price is 25 yuan per month.",
        },
        {
            "gap_id": "gap_2",
            "action": "rewrite_only",
            "tool": "semantic_rewrite_section",
            "claim": "Kimi is suitable for long-document analysis.",
        },
    ]

    calls = build_semantic_repair_calls("competitive research task", actions)

    assert len(calls) == 1
    assert calls[0]["tool"] == "repair_search"
    assert calls[0]["arguments"]["gap_ids"] == ["gap_1"]
    assert "Kimi member price" in calls[0]["arguments"]["query"]


def test_semantic_repair_query_uses_gap_location_instead_of_long_claim():
    task = """
[COMPETITIVE_RESEARCH_MODE]
研究主题：国内外 AI 搜索产品
竞品范围：Perplexity、秘塔AI、夸克AI
研究维度：会员价格、近期更新
研究地区：国内外
时间范围：最近 6 个月
"""
    actions = [
        {
            "gap_id": "semantic_gap_1",
            "action": "search_and_rewrite",
            "tool": "semantic_repair_search",
            "claim": "免费额度：不限次，全功能免费；付费方案：暂未推出付费版；核心付费功能：—；来源：([AI工具箱，2026](https://ai-tools.publicdata.online/articles/2026-05-06-ai-search-tools-comparison-2026.html))",
            "location": {"competitor": "秘塔AI", "dimension": "会员价格"},
        }
    ]

    calls = build_semantic_repair_calls(task, actions)

    query = calls[0]["arguments"]["query"]
    assert "秘塔AI" in query
    assert "会员价格" in query
    assert "官方" in query
    assert "https://" not in query
    assert "免费额度：不限次" not in query
    assert len(query) <= 80


def test_apply_risk_annotations_keeps_user_report_clean():
    report = "# Report\nBody"
    validation = {
        "semantic_gaps": [
            {
                "id": "gap_1",
                "claim": "Kimi member price is 25 yuan per month.",
                "severity": "high",
                "location": {"section": "Pricing and commercialization"},
            }
        ]
    }

    updated = apply_risk_annotations(report, validation)
    updated_again = apply_risk_annotations(updated, validation)

    assert updated == report
    assert updated_again == report
    assert "\u8bed\u4e49\u6821\u9a8c\u4e0e\u5f85\u786e\u8ba4\u98ce\u9669" not in updated
    assert "\u98ce\u9669\u7b49\u7ea7" not in updated
    assert "Kimi member price is 25 yuan per month." not in updated


def test_semantic_remediation_strategy_config_maps_experiment_modes():
    assert get_semantic_remediation_config("0-cycle") == {"mode": "0-cycle", "max_cycles": 0}
    assert get_semantic_remediation_config("1-cycle") == {"mode": "1-cycle", "max_cycles": 1}
    assert get_semantic_remediation_config("2-cycle") == {"mode": "2-cycle", "max_cycles": 2}
    assert get_semantic_remediation_config("pre-only") == {"mode": "pre-only", "max_cycles": 0}
    assert get_semantic_remediation_config("post-only") == {"mode": "post-only", "max_cycles": 1}


def test_prepare_rewrite_actions_downgrades_failed_search_to_risk_only():
    actions = [
        {
            "id": "a1",
            "gap_id": "g1",
            "action": "search_and_rewrite",
            "claim": "Unsupported claim",
        },
        {
            "id": "a2",
            "gap_id": "g2",
            "action": "rewrite_only",
            "claim": "Evidence-backed wording issue",
        },
    ]

    prepared = prepare_rewrite_actions(actions, repair_context="", repaired_sources=[])

    assert prepared[0]["action"] == "risk_only"
    assert prepared[0]["downgrade_reason"] == "no_new_evidence"
    assert prepared[1]["action"] == "rewrite_only"


def test_decide_remediation_outcome_rolls_back_when_revalidation_gets_worse():
    before = {
        "summary": {
            "semantic_gap_count": 2,
            "unsupported": 1,
            "weakly_supported": 1,
            "needs_human_review": 0,
        }
    }
    after = {
        "summary": {
            "semantic_gap_count": 4,
            "unsupported": 3,
            "weakly_supported": 0,
            "needs_human_review": 0,
        }
    }

    outcome = decide_remediation_outcome(before, after)

    assert outcome["decision"] == "rollback"
    assert outcome["unsupported_delta"] == 2
    assert outcome["semantic_gap_delta"] == 2


def test_decide_remediation_outcome_accepts_net_improvement():
    before = {
        "summary": {
            "semantic_gap_count": 3,
            "unsupported": 2,
            "weakly_supported": 1,
            "needs_human_review": 0,
        }
    }
    after = {
        "summary": {
            "semantic_gap_count": 1,
            "unsupported": 1,
            "weakly_supported": 0,
            "needs_human_review": 0,
        }
    }

    outcome = decide_remediation_outcome(before, after)

    assert outcome["decision"] == "accept"
    assert outcome["net_improvement"] > 0


def test_semantic_remediation_rolls_back_when_rewrite_gets_worse(monkeypatch):
    class FakeCfg:
        strategic_llm_model = "fake"
        strategic_llm_provider = "fake"
        strategic_token_limit = 1000
        llm_kwargs = {}

    class FakeResearcher:
        cfg = FakeCfg()
        kwargs = {}
        websocket = None
        context = "existing evidence"
        competitive_agent_metadata = {"evidence_ledger": []}

        def add_costs(self, *_args, **_kwargs):
            return None

        def get_research_sources(self):
            return []

    initial_validation = {
        "summary": {
            "semantic_gap_count": 1,
            "unsupported": 1,
            "weakly_supported": 0,
            "needs_human_review": 0,
        },
        "semantic_gaps": [
            {
                "id": "gap_1",
                "claim": "unsupported original claim",
                "severity": "high",
                "location": {"section": "pricing"},
            }
        ],
    }
    worse_validation = {
        "summary": {
            "semantic_gap_count": 2,
            "unsupported": 2,
            "weakly_supported": 0,
            "needs_human_review": 0,
        },
        "semantic_gaps": [
            {"id": "gap_2", "claim": "new unsupported claim", "severity": "high", "location": {"section": "pricing"}},
            {"id": "gap_3", "claim": "another unsupported claim", "severity": "high", "location": {"section": "trend"}},
        ],
    }
    validations = [initial_validation, worse_validation]

    async def fake_validator(*_args, **_kwargs):
        return validations.pop(0)

    async def fake_rewrite(*_args, **_kwargs):
        return "# Report\nrewritten stronger claim"

    async def fake_stream_output(*_args, **_kwargs):
        return None

    monkeypatch.setattr(semantic_remediation_module, "is_competitive_research_task", lambda _task: True)
    monkeypatch.setattr(semantic_remediation_module, "run_semantic_validator", fake_validator)
    monkeypatch.setattr(
        semantic_remediation_module,
        "plan_remediation_actions",
        lambda _validation: [{"gap_id": "gap_1", "action": "rewrite_only", "claim": "unsupported original claim"}],
    )
    monkeypatch.setattr(semantic_remediation_module, "_rewrite_report_with_actions", fake_rewrite)
    monkeypatch.setattr(semantic_remediation_module, "stream_output", fake_stream_output)

    final_report, metadata = asyncio.run(
        semantic_remediation_module.run_competitive_semantic_remediation(
            FakeResearcher(),
            "竞品研究：Kimi 产品定位",
            "# Report\noriginal claim",
            max_cycles=1,
            mode="1-cycle",
        )
    )

    cycle = metadata["semantic_remediation"]["cycles"][0]
    assert cycle["decision"] == "rollback"
    assert metadata["semantic_remediation"]["rolled_back_cycles"] == 1
    assert "rewritten stronger claim" not in final_report
    assert "original claim" in final_report
