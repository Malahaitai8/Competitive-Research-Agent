"""Tests for sub-query response normalization.

`generate_sub_queries` returns the raw output of `json_repair.loads`, which can
be a list, a dict, a bare string, or None depending on what the LLM emits.
Downstream callers (researcher.plan_research) treat the result as a `list[str]`
and call `.append(...)` / iterate over it, so a non-list response crashes the
whole research run. `_normalize_sub_queries` guarantees a flat `list[str]`.
"""

import unittest
from types import SimpleNamespace

from gpt_researcher.actions.query_processing import _normalize_sub_queries
from gpt_researcher.skills.researcher import ResearchConductor, _should_append_original_query


class TestNormalizeSubQueries(unittest.TestCase):
    def test_plain_list(self):
        self.assertEqual(
            _normalize_sub_queries(["a", "b"], "orig"),
            ["a", "b"],
        )

    def test_dict_with_queries_key(self):
        self.assertEqual(
            _normalize_sub_queries({"queries": ["a", "b"]}, "orig"),
            ["a", "b"],
        )

    def test_single_query_dict(self):
        self.assertEqual(
            _normalize_sub_queries({"query": "only one"}, "orig"),
            ["only one"],
        )

    def test_bare_string_response(self):
        self.assertEqual(
            _normalize_sub_queries("just a string", "orig"),
            ["just a string"],
        )

    def test_empty_string_falls_back_to_original_query(self):
        # json_repair returns "" for unparseable output.
        self.assertEqual(
            _normalize_sub_queries("", "original query"),
            ["original query"],
        )

    def test_none_falls_back_to_original_query(self):
        self.assertEqual(
            _normalize_sub_queries(None, "original query"),
            ["original query"],
        )

    def test_strips_and_drops_blanks(self):
        self.assertEqual(
            _normalize_sub_queries(["  a  ", "", "  ", "b"], "orig"),
            ["a", "b"],
        )

    def test_unrecognized_dict_shape_falls_back(self):
        self.assertEqual(
            _normalize_sub_queries({"unexpected": 1}, "original query"),
            ["original query"],
        )

    def test_competitive_marker_task_is_not_appended_as_a_search_query(self):
        self.assertFalse(
            _should_append_original_query(
                "[COMPETITIVE_RESEARCH_MODE]\n研究主题：国内 AI 搜索产品"
            )
        )

    def test_plain_research_task_keeps_original_query_search(self):
        self.assertTrue(_should_append_original_query("AI 搜索产品市场规模"))


class TestSubQueryTimeout(unittest.IsolatedAsyncioTestCase):
    async def test_slow_subquery_returns_empty_context_after_timeout(self):
        conductor = object.__new__(ResearchConductor)
        conductor.researcher = SimpleNamespace(verbose=False, websocket=None)

        async def slow_subquery(*_args):
            import asyncio

            await asyncio.sleep(0.05)
            return "late context"

        conductor._process_sub_query = slow_subquery

        result = await conductor._process_sub_query_with_timeout(
            "slow query",
            [],
            [],
            timeout_seconds=0.01,
        )

        self.assertEqual(result, "")


if __name__ == "__main__":
    unittest.main()
