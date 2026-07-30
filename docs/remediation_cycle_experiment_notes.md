# Remediation Cycle Experiment Notes

Run time: 2026-07-26

Case:
- Research topic: AI search product smoke experiment
- Competitor: Kimi
- Dimension: product positioning
- Region: China
- Time range: recent 6 months
- `max_search_results=1`

Output:
- `outputs/remediation_experiment_20260726_112603/comparison_recomputed.json`
- Per-strategy analysis JSON files are in the same directory.

Compared strategies:
- `0-cycle`: generate report and mark risk only; no Evidence Gate repair and no semantic remediation.
- `1-cycle`: Evidence Gate repair + at most one semantic remediation cycle.
- `2-cycle`: Evidence Gate repair + at most two semantic remediation cycles.
- `pre-only`: only Evidence Gate repair; after generation only validate/mark risk.
- `post-only`: no Evidence Gate repair; after generation validate and remediate.

Key results:
- `0-cycle`: 86.121s, semantic gaps 3 -> 3, no repair.
- `1-cycle`: 256.577s, Evidence Gate had 6 tool steps, semantic remediation ran 1 cycle, but revalidation produced more unsupported claims.
- `2-cycle`: 108.939s, semantic gaps were already 0 before remediation, so no semantic cycle actually ran. This does not prove 2-cycle is better.
- `pre-only`: 104.740s, semantic gaps 3 -> 3.
- `post-only`: 138.791s, semantic remediation ran 1 cycle, but semantic gaps increased 4 -> 10 after rewrite/revalidation.

Interview conclusion:
The smoke experiment does not support blindly choosing 2-cycle. The useful finding is that remediation is not monotonically better: search and rewrite can introduce stronger unsupported claims. A safer production default is still max 1 remediation cycle, with 2-cycle reserved for deep mode or further experiments on a broader eval set.

Follow-up optimization:
- Production remediation should not be a naive rewrite loop. It is now a guarded 1-cycle strategy.
- If `search_and_rewrite` does not retrieve new evidence, it is downgraded to `risk_only`; the system marks the claim as pending confirmation instead of forcing a rewrite.
- After every rewrite, Semantic Validator rechecks the affected result. If unsupported claims or semantic gaps increase, the remediation is rolled back and the original report is kept with risk annotations.
- If revalidation improves unsupported/gap/weak-support counts, the rewrite is accepted.
- If revalidation is neutral, the rewrite may be kept only with remaining risk annotations, and the loop stops when no useful new action exists.
- Updated interview wording: the experiment revealed that remediation must be measured by net benefit, not by whether one more cycle exists. The final design keeps remediation useful while preventing it from strengthening unsupported conclusions.

Retest note:
- After adding the guarded cycle, a full live rerun was attempted on 2026-07-26.
- The run did not produce a new comparison result because the external LLM endpoint and DuckDuckGo search repeatedly failed to connect and the command timed out after 15 minutes.
- Local verification therefore used unit and integration tests for the guarded behavior: downgrade failed search to `risk_only`, accept net-improving rewrites, and roll back rewrites that make semantic validation worse.

Bad cases found:
- Local rewrite may make claims stronger than the evidence supports.
- Post-only remediation can amplify unsupported claims when the initial evidence base is weak.
- Search can return captcha pages, blocked pages, or relative URLs, raising latency without adding useful sources.
- Gap IDs are unstable across LLM revalidation, so fixed-rate metrics must use gap/status counts, not gap-id set difference.
