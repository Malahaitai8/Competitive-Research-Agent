from gpt_researcher.prompts import PromptFamily
from gpt_researcher.utils.enum import ReportSource, Tone


def test_competitive_report_prompt_requires_all_competitors_in_matrix():
    prompt = PromptFamily.generate_report_prompt(
        question=(
            "[COMPETITIVE_RESEARCH_MODE]\n"
            "研究主题：国内 Agent 产品竞品研究\n"
            "竞品范围：Trae、Marvis、WorkBuddy\n"
            "研究维度：产品定位、目标用户、核心功能、会员价格、近期更新\n"
        ),
        context="official and third-party evidence",
        report_source=ReportSource.Web.value,
        tone=Tone.Objective,
        language="chinese",
    )

    assert "用户输入的所有竞品必须出现在核心功能对比矩阵中" in prompt
    assert "不要因为缺少官方来源、公开信息不足或名称需要确认而省略某个竞品" in prompt
    assert "暂未找到官方公开信息" in prompt


def test_competitive_report_prompt_keeps_source_notes_below_matrix():
    prompt = PromptFamily.generate_report_prompt(
        question="[COMPETITIVE_RESEARCH_MODE]\n竞品范围：Trae、Marvis、WorkBuddy",
        context="official and third-party evidence",
        report_source=ReportSource.Web.value,
        tone=Tone.Objective,
        language="chinese",
    )

    assert "矩阵单元格默认使用官方来源支撑的信息" in prompt
    assert "不要为矩阵单独增加“来源”列" in prompt
    assert "在矩阵下方统一标注" in prompt
