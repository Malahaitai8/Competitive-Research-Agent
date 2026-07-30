import argparse
import asyncio
import glob
import json
import os
import sys
import time
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "backend"))

try:
    from dotenv import load_dotenv

    load_dotenv(REPO_ROOT / ".env")
except Exception:
    pass

from backend.server.competitive_research import COMPETITIVE_MARKER, analyze_competitive_report, collect_competitive_metadata
from backend.server.remediation_experiment import build_strategy_metrics, compare_strategy_metrics
from backend.server.websocket_manager import run_agent
from gpt_researcher.utils.enum import ReportType, Tone


DEFAULT_TASK = f"""{COMPETITIVE_MARKER}
\u7814\u7a76\u4e3b\u9898\uff1aAI\u641c\u7d22\u4ea7\u54c1\u5192\u70df\u5b9e\u9a8c
\u7ade\u54c1\u8303\u56f4\uff1aKimi
\u7814\u7a76\u7ef4\u5ea6\uff1a\u4ea7\u54c1\u5b9a\u4f4d
\u7814\u7a76\u5730\u533a\uff1a\u4e2d\u56fd
\u65f6\u95f4\u8303\u56f4\uff1a\u6700\u8fd16\u4e2a\u6708
\u8865\u5145\u8981\u6c42\uff1a\u7528\u4e8e remediation cycle \u5bf9\u7167\u5b9e\u9a8c\uff0c\u62a5\u544a\u5c3d\u91cf\u7b80\u77ed\u3002
"""

STRATEGIES = ("0-cycle", "1-cycle", "2-cycle", "pre-only", "post-only")


def _load_json(path: str) -> dict[str, Any]:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _strategy_from_path(path: str) -> str:
    lower = os.path.basename(path).lower()
    for strategy in STRATEGIES:
        if strategy in lower:
            return strategy
    return "unknown"


def build_records(paths: list[str]) -> list[dict[str, Any]]:
    records = []
    for path in paths:
        payload = _load_json(path)
        before = payload.get("semantic_validation") or {}
        after = payload.get("semantic_revalidation") or before
        remediation = payload.get("semantic_remediation") or {}
        agent_trace = payload.get("agent_trace") or {}
        agent_tool_calls = agent_trace.get("tool_calls") or []
        semantic_executed_calls = remediation.get("executed_calls") or []
        records.append(build_strategy_metrics(
            strategy=payload.get("strategy") or _strategy_from_path(path),
            validation_before=before,
            validation_after=after,
            runtime_seconds=float(payload.get("runtime_seconds") or 0),
            llm_calls=int(payload.get("llm_calls") or 0),
            search_calls=(
                len(remediation.get("repair_calls") or [])
                + sum(1 for call in agent_tool_calls if call.get("tool") == "web_search")
            ),
            scrape_calls=(
                sum(1 for call in semantic_executed_calls if call.get("tool") == "scrape_url")
                + sum(1 for call in agent_tool_calls if call.get("tool") == "scrape_url")
            ),
            rewritten_sections=int(payload.get("rewritten_sections") or (1 if remediation.get("rewritten") else 0)),
            added_sources=int(remediation.get("repaired_source_count") or 0) + int(payload.get("repaired_source_count") or 0),
            duplicate_sources=int(payload.get("duplicate_sources") or 0),
            new_error_count=int(payload.get("new_error_count") or 0),
        ))
    return records


@contextmanager
def _strategy_environment(strategy: str):
    old_semantic = os.environ.get("COMPETITIVE_SEMANTIC_REMEDIATION_MODE")
    old_gate = os.environ.get("COMPETITIVE_EVIDENCE_GATE_MODE")
    os.environ["COMPETITIVE_SEMANTIC_REMEDIATION_MODE"] = strategy
    os.environ["COMPETITIVE_EVIDENCE_GATE_MODE"] = "diagnose_only" if strategy in {"0-cycle", "post-only"} else "repair"
    try:
        yield
    finally:
        if old_semantic is None:
            os.environ.pop("COMPETITIVE_SEMANTIC_REMEDIATION_MODE", None)
        else:
            os.environ["COMPETITIVE_SEMANTIC_REMEDIATION_MODE"] = old_semantic
        if old_gate is None:
            os.environ.pop("COMPETITIVE_EVIDENCE_GATE_MODE", None)
        else:
            os.environ["COMPETITIVE_EVIDENCE_GATE_MODE"] = old_gate


def _load_tasks(case_file: str, inline_task: str) -> list[dict[str, str]]:
    if inline_task:
        return [{"id": "inline", "task": inline_task}]
    if not case_file:
        return [{"id": "smoke_kimi_positioning", "task": DEFAULT_TASK}]

    payload = _load_json(case_file)
    if isinstance(payload, list):
        cases = payload
    else:
        cases = payload.get("cases") or [payload]
    tasks = []
    for index, item in enumerate(cases, start=1):
        if isinstance(item, str):
            tasks.append({"id": f"case_{index}", "task": item})
        else:
            tasks.append({"id": str(item.get("id") or f"case_{index}"), "task": str(item.get("task") or "")})
    return [item for item in tasks if item["task"].strip()]


async def _run_one(case: dict[str, str], strategy: str, args: argparse.Namespace, output_dir: Path) -> str:
    started = time.perf_counter()
    error = ""
    report = ""
    researcher = None
    with _strategy_environment(strategy):
        try:
            result = await run_agent(
                task=case["task"],
                report_type=args.report_type,
                report_source=args.report_source,
                source_urls=[],
                document_urls=[],
                tone=Tone[args.tone],
                websocket=None,
                headers={},
                query_domains=[],
                config_path=os.environ.get("CONFIG_PATH", "default"),
                return_researcher=True,
                max_search_results=args.max_search_results,
            )
            report, researcher = result
        except Exception as exc:
            error = str(exc)

    runtime_seconds = round(time.perf_counter() - started, 3)
    metadata = collect_competitive_metadata(researcher)
    analysis = analyze_competitive_report(case["task"], str(report or ""), agent_metadata=metadata)
    analysis.update({
        "case_id": case["id"],
        "strategy": strategy,
        "runtime_seconds": runtime_seconds,
        "llm_calls": 0,
        "new_error_count": 1 if error else 0,
        "error": error,
    })
    output_path = output_dir / f"{case['id']}_{strategy}.json"
    output_path.write_text(json.dumps(analysis, ensure_ascii=False, indent=2), encoding="utf-8")
    return str(output_path)


async def run_strategy_experiment(args: argparse.Namespace) -> dict[str, Any]:
    run_id = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_dir = Path(args.output_dir or "outputs") / f"remediation_experiment_{run_id}"
    output_dir.mkdir(parents=True, exist_ok=True)
    tasks = _load_tasks(args.case_file, args.task)
    strategies = [item.strip() for item in args.strategies.split(",") if item.strip()]
    output_paths = []
    for case in tasks:
        for strategy in strategies:
            output_paths.append(await _run_one(case, strategy, args, output_dir))
    records = build_records(output_paths)
    comparison = compare_strategy_metrics(records)
    comparison.update({
        "run_id": run_id,
        "case_count": len(tasks),
        "strategies": strategies,
        "analysis_files": output_paths,
    })
    summary_path = output_dir / "comparison.json"
    summary_path.write_text(json.dumps(comparison, ensure_ascii=False, indent=2), encoding="utf-8")
    comparison["comparison_path"] = str(summary_path)
    return comparison


def aggregate_existing(inputs: list[str], output: str) -> str:
    paths = []
    for item in inputs:
        matches = glob.glob(item)
        paths.extend(matches or [item])
    paths = [path for path in paths if os.path.exists(path)]
    if not paths:
        raise SystemExit("No input analysis JSON files found.")

    records = build_records(paths)
    comparison = compare_strategy_metrics(records)
    output_path = output or os.path.join("outputs", f"remediation_experiment_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json")
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(comparison, f, ensure_ascii=False, indent=2)
    return output_path


def main() -> int:
    parser = argparse.ArgumentParser(description="Run or aggregate remediation-cycle strategy experiments.")
    parser.add_argument("inputs", nargs="*", help="Existing analysis JSON paths/globs. If provided, only aggregate these files.")
    parser.add_argument("--task", default="", help="Inline competitive research task.")
    parser.add_argument("--case-file", default="", help="JSON file containing cases to run.")
    parser.add_argument("--strategies", default=",".join(STRATEGIES), help="Comma-separated strategies to run.")
    parser.add_argument("--report-type", default=ReportType.ResearchReport.value)
    parser.add_argument("--report-source", default="web")
    parser.add_argument("--tone", default="Objective")
    parser.add_argument("--max-search-results", type=int, default=2)
    parser.add_argument("--output", default="", help="Aggregate output JSON path for existing inputs.")
    parser.add_argument("--output-dir", default="", help="Directory for new experiment outputs.")
    args = parser.parse_args()

    if args.inputs:
        print(aggregate_existing(args.inputs, args.output))
        return 0

    comparison = asyncio.run(run_strategy_experiment(args))
    print(comparison["comparison_path"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
