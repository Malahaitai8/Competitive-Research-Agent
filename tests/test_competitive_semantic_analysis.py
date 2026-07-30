from backend.server.competitive_research import (
    COMPETITIVE_MARKER,
    analyze_competitive_report,
    build_competitive_matrix,
    collect_competitive_metadata,
    extract_competitive_request,
)
from backend.server.competitor_normalization import (
    parse_competitor_normalization_response,
    rewrite_competitive_task_competitors,
)
from gpt_researcher.competitive_sources import (
    is_usable_source_url,
    official_source_query_seeds,
)


def test_competitive_analysis_includes_semantic_validation():
    task = f"""{COMPETITIVE_MARKER}
研究主题：AI 搜索产品竞品分析
竞品范围：Kimi
研究维度：会员价格
研究地区：中国
时间范围：最近 6 个月
"""
    report = "## 定价与商业化方式\nKimi 会员价格为每月 25 元。"
    analysis = analyze_competitive_report(
        task,
        report,
        agent_metadata={"evidence_ledger": []},
    )

    assert "semantic_validation" in analysis
    assert analysis["semantic_validation"]["claim_validation"]
    assert analysis["semantic_validation"]["semantic_gaps"]


def test_collect_competitive_metadata_merges_agent_and_semantic_metadata():
    class Researcher:
        competitive_agent_metadata = {"evidence_ledger": [{"claim": "a"}]}
        competitive_semantic_metadata = {"semantic_remediation": {"cycles_executed": 1}}

    metadata = collect_competitive_metadata(Researcher())

    assert metadata["evidence_ledger"] == [{"claim": "a"}]
    assert metadata["semantic_remediation"]["cycles_executed"] == 1


def test_extract_competitive_request_preserves_raw_competitors_before_llm_normalization():
    task = f"""{COMPETITIVE_MARKER}
研究主题：国内外短视频平台
竞品范围：tictok、抖音、快手
研究维度：产品定位
研究地区：国内外
时间范围：最近 6 个月
"""

    request = extract_competitive_request(task)

    assert request["competitors"] == ["tictok", "抖音", "快手"]
    assert request["competitor_aliases"]["tictok"] == ["tictok"]


def test_parse_competitor_normalization_response_uses_llm_aliases_across_categories():
    response = """
{
  "competitors": [
    {"original_name": "RED", "canonical_name": "小红书", "aliases": ["RED", "Xiaohongshu"], "confidence": 0.93, "reason": "common brand alias"},
    {"original_name": "油管 Shorts", "canonical_name": "YouTube Shorts", "aliases": ["油管 Shorts", "Youtube Shorts"], "confidence": 0.91, "reason": "Chinese nickname"},
    {"original_name": "Claude", "canonical_name": "Claude", "aliases": ["Anthropic Claude"], "confidence": 0.98, "reason": "same product"},
    {"original_name": "文心一言", "canonical_name": "文心一言", "aliases": ["ERNIE Bot"], "confidence": 0.97, "reason": "same product"}
  ]
}
"""

    result = parse_competitor_normalization_response(
        response,
        ["RED", "油管 Shorts", "Claude", "文心一言"],
    )

    assert result["normalized_competitors"] == ["小红书", "YouTube Shorts", "Claude", "文心一言"]
    assert "RED" in result["competitor_aliases"]["小红书"]
    assert "油管 Shorts" in result["competitor_aliases"]["YouTube Shorts"]


def test_competitor_normalization_keeps_low_confidence_names_unmerged():
    response = """
{
  "competitors": [
    {"original_name": "Threads", "canonical_name": "Instagram Reels", "aliases": ["Threads"], "confidence": 0.41, "reason": "uncertain"}
  ]
}
"""

    result = parse_competitor_normalization_response(response, ["Threads"])

    assert result["normalized_competitors"] == ["Threads"]
    assert result["ambiguous_items"][0]["original_name"] == "Threads"


def test_rewrite_competitive_task_competitors_updates_scope_line():
    task = f"""{COMPETITIVE_MARKER}
研究主题：国内外短视频平台
竞品范围：tictok、抖音、快手
研究维度：产品定位
"""

    rewritten = rewrite_competitive_task_competitors(task, ["TikTok", "抖音", "快手"])

    assert "竞品范围：TikTok、抖音、快手" in rewritten
    assert "竞品范围：tictok、抖音、快手" not in rewritten


def test_build_competitive_matrix_matches_canonical_aliases():
    request = {
        "competitors": ["TikTok"],
        "competitor_aliases": {"TikTok": ["TikTok", "tictok", "tik tok"]},
        "dimensions": ["产品定位"],
    }
    report = "## 产品定位\nTikTok 是面向全球用户的短视频平台，产品定位是内容创作与分发平台。"

    matrix = build_competitive_matrix(request, report)

    assert matrix["competitors"] == ["TikTok"]
    assert matrix["rows"][0]["competitor"] == "TikTok"
    assert matrix["rows"][0]["cells"]["产品定位"]["status"] == "found"


def test_build_competitive_matrix_ignores_generic_scope_sentences():
    request = {
        "competitors": ["marvis"],
        "competitor_aliases": {"marvis": ["marvis", "Marvis"]},
        "dimensions": ["产品定位", "目标用户", "核心功能", "会员价格"],
    }
    report = """
## 研究说明
本报告旨在对国内三款主流AI Agent产品——Trea、Marvis和WorkBuddy进行横向竞品研究，以帮助企业用户、开发者及个人用户了解产品差异，做出选型决策。研究维度涵盖产品定位、目标用户、核心功能、会员价格、商业化方式及近期更新。

## 核心功能
Marvis 的核心功能包括任务自主规划、文件与系统操作、多Agent架构和办公文档生成。
"""

    matrix = build_competitive_matrix(request, report)
    cells = matrix["rows"][0]["cells"]

    assert cells["产品定位"]["status"] == "missing"
    assert cells["目标用户"]["status"] == "missing"
    assert cells["会员价格"]["status"] == "missing"
    assert cells["核心功能"]["status"] == "found"
    assert "任务自主规划" in cells["核心功能"]["summary"]


def test_source_url_cleaning_rejects_relative_startpage_click_urls():
    assert not is_usable_source_url("/clev?event=StartpageResultClick&payload=x")
    assert not is_usable_source_url("javascript:void(0)")
    assert is_usable_source_url("https://www.perplexity.ai/hub/blog")


def test_official_source_query_seeds_cover_ai_search_products():
    task = f"""{COMPETITIVE_MARKER}
研究主题：国内外 AI 搜索产品
竞品范围：Perplexity、秘塔AI、夸克AI
研究维度：产品定位、会员价格、近期更新
研究地区：国内外
时间范围：最近 6 个月
"""

    queries = official_source_query_seeds(task, max_queries=6)
    joined = "\n".join(queries)

    assert "Perplexity official" in joined
    assert "秘塔AI 官网" in joined
    assert "夸克AI 官方" in joined


def test_analysis_counts_process_official_urls_from_agent_trace():
    task = f"""{COMPETITIVE_MARKER}
研究主题：国内外 AI 搜索产品
竞品范围：秘塔AI
研究维度：产品定位
研究地区：国内外
时间范围：最近 6 个月
"""
    report = "## 产品定位\n秘塔AI 是 AI 搜索产品。"

    analysis = analyze_competitive_report(
        task,
        report,
        agent_metadata={
            "agent_trace": {
                "tool_calls": [
                    {
                        "tool": "web_search",
                        "output": {
                            "urls": [
                                "https://metaso.cn/",
                                "/clev?event=StartpageResultClick",
                            ]
                        },
                    }
                ]
            }
        },
    )

    assert "https://metaso.cn/" in analysis["urls"]
    assert "/clev?event=StartpageResultClick" not in analysis["urls"]
    assert analysis["official_like_source_count"] == 1


def test_analysis_does_not_count_third_party_blog_as_official_like():
    task = f"""{COMPETITIVE_MARKER}
research topic: AI search products
competitors: Metaso
dimensions: positioning
region: global
time range: recent 6 months
"""
    report = "## Product positioning\nMetaso is an AI search product."

    analysis = analyze_competitive_report(
        task,
        report,
        agent_metadata={
            "agent_trace": {
                "tool_calls": [
                    {
                        "tool": "web_search",
                        "output": {
                            "urls": [
                                "https://blog.csdn.net/AI_Gump/article/details/138320290",
                                "https://metaso.cn/",
                            ]
                        },
                    }
                ]
            }
        },
    )

    assert "https://blog.csdn.net/AI_Gump/article/details/138320290" in analysis["urls"]
    assert "https://blog.csdn.net/AI_Gump/article/details/138320290" not in analysis["official_like_urls"]
    assert analysis["official_like_urls"] == ["https://metaso.cn/"]
