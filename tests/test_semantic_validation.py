from backend.server.semantic_validation import (
    build_semantic_validation,
    plan_remediation_actions,
)


def test_semantic_validator_checks_matrix_and_report_claims():
    matrix = {
        "rows": [
            {
                "competitor": "Kimi",
                "cells": {
                    "会员价格": {
                        "status": "found",
                        "summary": "Kimi 会员价格为每月 25 元。",
                        "evidence": [],
                    }
                },
            }
        ]
    }
    report = "## 定价与商业化方式\nKimi 会员价格为每月 25 元。"
    validation = build_semantic_validation(
        report=report,
        matrix=matrix,
        evidence_ledger=[],
    )

    assert validation["matrix_validation"][0]["status"] == "unsupported"
    assert validation["claim_validation"][0]["status"] == "unsupported"
    assert validation["semantic_gaps"][0]["type"] in {
        "matrix_unsupported",
        "claim_unsupported",
    }


def test_remediation_controller_prefers_rewrite_when_evidence_exists():
    validation = {
        "semantic_gaps": [
            {
                "id": "gap_1",
                "type": "claim_unsupported",
                "severity": "high",
                "claim": "Kimi 适合长文档分析。",
                "matching_evidence_count": 2,
            },
            {
                "id": "gap_2",
                "type": "matrix_unsupported",
                "severity": "high",
                "claim": "Kimi 会员价格为每月 25 元。",
                "matching_evidence_count": 0,
            },
        ]
    }

    actions = plan_remediation_actions(validation, max_actions=3)

    assert actions[0]["action"] == "rewrite_only"
    assert actions[1]["action"] == "search_and_rewrite"
    assert {action["tool"] for action in actions} <= {
        "semantic_rewrite_section",
        "semantic_repair_search",
        "semantic_risk_annotation",
    }


def test_remediation_controller_rejects_unknown_actions():
    validation = {
        "semantic_gaps": [
            {
                "id": "gap_1",
                "type": "claim_unsupported",
                "severity": "high",
                "claim": "未知结论",
                "matching_evidence_count": 0,
                "recommended_action": "free_browse_and_call_any_tool",
            }
        ]
    }

    actions = plan_remediation_actions(validation)

    assert actions[0]["action"] == "search_and_rewrite"
    assert actions[0]["tool"] == "semantic_repair_search"


def test_llm_validation_synthesizes_gaps_for_unsupported_items():
    validation = build_semantic_validation(
        report="## 定价\nKimi 价格为 25 元。",
        matrix={},
        evidence_ledger=[],
        llm_result={
            "matrix_validation": [],
            "claim_validation": [
                {
                    "section": "定价",
                    "claim": "Kimi 价格为 25 元。",
                    "status": "unsupported",
                    "matching_evidence_count": 0,
                }
            ],
            "semantic_gaps": [],
        },
    )

    assert validation["semantic_gaps"]
    assert validation["semantic_gaps"][0]["type"] == "claim_unsupported"
