from backend.server.agent_repair import should_execute_evidence_repair
from backend.server.semantic_remediation import get_semantic_remediation_config


def test_semantic_remediation_strategy_config_maps_experiment_modes():
    assert get_semantic_remediation_config("0-cycle") == {"mode": "0-cycle", "max_cycles": 0}
    assert get_semantic_remediation_config("1-cycle") == {"mode": "1-cycle", "max_cycles": 1}
    assert get_semantic_remediation_config("2-cycle") == {"mode": "2-cycle", "max_cycles": 2}
    assert get_semantic_remediation_config("pre-only") == {"mode": "pre-only", "max_cycles": 0}
    assert get_semantic_remediation_config("post-only") == {"mode": "post-only", "max_cycles": 1}


def test_should_execute_evidence_repair_skips_post_only_and_diagnose_only():
    assert should_execute_evidence_repair("repair") is True
    assert should_execute_evidence_repair("1-cycle") is True
    assert should_execute_evidence_repair("post-only") is False
    assert should_execute_evidence_repair("diagnose_only") is False
