import os

from scripts.run_remediation_experiment import _strategy_environment


def test_strategy_environment_disables_evidence_repair_for_zero_and_post_only():
    old_gate = os.environ.get("COMPETITIVE_EVIDENCE_GATE_MODE")
    try:
        with _strategy_environment("0-cycle"):
            assert os.environ["COMPETITIVE_EVIDENCE_GATE_MODE"] == "diagnose_only"
        with _strategy_environment("post-only"):
            assert os.environ["COMPETITIVE_EVIDENCE_GATE_MODE"] == "diagnose_only"
        with _strategy_environment("pre-only"):
            assert os.environ["COMPETITIVE_EVIDENCE_GATE_MODE"] == "repair"
    finally:
        if old_gate is None:
            os.environ.pop("COMPETITIVE_EVIDENCE_GATE_MODE", None)
        else:
            os.environ["COMPETITIVE_EVIDENCE_GATE_MODE"] = old_gate
