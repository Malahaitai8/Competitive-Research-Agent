from backend.server.competitive_research import (
    COMPETITIVE_MARKER,
    analyze_competitive_report,
    extract_report_citation_urls,
)
from gpt_researcher.competitive_sources import classify_source_url


def _task(time_range: str = "最近 6 个月") -> str:
    return f"""{COMPETITIVE_MARKER}
研究主题：中国 AI 产品
竞品范围：OpenAI、示例产品
研究维度：产品定位、会员价格、近期更新
研究地区：全球
时间范围：{time_range}
"""


def test_reading_context_counts_only_normalized_text_citations():
    report = """
## 摘要
[OpenAI 官网](https://openai.com/?utm_source=report) 与
[OpenAI 官网重复引用](https://openai.com/#overview)。
[监管披露](https://www.sec.gov/filing?id=1&utm_campaign=test)。
[媒体报道](https://www.thepaper.cn/newsDetail_forward_1)。
![参考图片](https://openai.com/assets/chart.png)
"""

    analysis = analyze_competitive_report(
        _task(),
        report,
        intermediate_results={
            "source_urls": ["https://blog.csdn.net/not-cited"],
        },
    )
    context = analysis["reading_context"]

    assert extract_report_citation_urls(report) == [
        "https://openai.com/",
        "https://www.sec.gov/filing?id=1",
        "https://www.thepaper.cn/newsDetail_forward_1",
    ]
    assert context["cited_source_count"] == 3
    assert context["official_source_count"] == 1
    assert context["authoritative_source_count"] == 2
    assert context["ordinary_source_count"] == 0
    assert context["weak_verification_source_count"] == 0
    assert [item["domain"] for item in context["source_domains"]] == [
        "openai.com",
        "sec.gov",
        "thepaper.cn",
    ]
    assert [item["category"] for item in context["source_domains"]] == [
        "official",
        "authoritative",
        "authoritative",
    ]
    assert all("csdn.net" not in item["domain"] for item in context["source_domains"])


def test_reading_context_uses_four_user_facing_source_tiers():
    report = """
[官方产品页](https://openai.com/product)
[监管披露](https://www.sec.gov/filing/1)
[普通行业站](https://dayaai.com/article/1)
[普通产品站](https://emergent.sh/blog/1)
[弱验证博客](https://blog.csdn.net/example/article/details/1)
"""

    context = analyze_competitive_report(_task(), report)["reading_context"]
    categories = {item["domain"]: item["category"] for item in context["source_domains"]}

    assert categories == {
        "openai.com": "official",
        "sec.gov": "authoritative",
        "dayaai.com": "ordinary",
        "emergent.sh": "ordinary",
        "blog.csdn.net": "weak_verification",
    }
    assert context["official_source_count"] == 1
    assert context["authoritative_source_count"] == 1
    assert context["ordinary_source_count"] == 2
    assert context["weak_verification_source_count"] == 1
    assert "弱验证来源" in context["confidence_summary"]


def test_shared_source_classifier_exposes_expected_tiers():
    assert classify_source_url("https://openai.com/product")["tier"] == "S"
    assert classify_source_url("https://www.sec.gov/filing/1")["tier"] == "A"
    assert classify_source_url("https://dayaai.com/article/1")["tier"] == "B"
    assert classify_source_url("https://emergent.sh/blog/1")["tier"] == "B"
    assert classify_source_url("https://www.zhihu.com/question/1")["tier"] == "C"
    assert classify_source_url("https://www.sohu.com/a/1")["tier"] == "C"


def test_reading_context_maps_validation_to_user_facing_language():
    analysis = analyze_competitive_report(
        _task("最近 3 个月"),
        "[产品说明](https://openai.com/product)",
        agent_metadata={
            "semantic_validation": {
                "claim_validation": [
                    {
                        "claim": "产品定位来自官方产品说明。",
                        "status": "supported",
                        "matching_evidence_count": 1,
                    },
                    {
                        "claim": "示例产品会员价格为每月 99 元。",
                        "status": "weakly_supported",
                        "matching_evidence_count": 0,
                    },
                ],
                "semantic_gaps": [
                    {
                        "location": {"competitor": "示例产品", "dimension": "近期更新"},
                    }
                ],
            }
        },
    )
    context = analysis["reading_context"]
    visible_copy = " ".join(
        [
            context["confidence_summary"],
            *context["supported_claims"],
            *context["attention_items"],
            *context["missing_items"],
            context["time_scope"]["note"],
        ]
    )

    assert context["supported_claims"] == ["产品定位来自官方产品说明。"]
    assert any("会员价格" in item and "官方定价页" in item for item in context["attention_items"])
    assert any("示例产品" in item and "近期更新" in item for item in context["missing_items"])
    assert "最近 3 个月" in context["time_scope"]["note"]
    assert "weakly_supported" not in visible_copy
    assert "风险等级" not in visible_copy


def test_reading_context_uses_neutral_empty_citation_copy():
    context = analyze_competitive_report(_task(), "## 摘要\n暂无外部链接。")["reading_context"]

    assert context["cited_source_count"] == 0
    assert context["source_domains"] == []
    assert context["confidence_summary"] == "正文暂未检测到可核验的外部引用。"
