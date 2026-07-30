import json
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse


COMPETITIVE_MARKER = "[COMPETITIVE_RESEARCH_MODE]"


@dataclass(frozen=True)
class OfficialSourceProfile:
    name: str
    aliases: tuple[str, ...]
    domains: tuple[str, ...]
    query_terms: tuple[str, ...]


DEFAULT_OFFICIAL_SOURCE_PROFILES: tuple[OfficialSourceProfile, ...] = (
    OfficialSourceProfile(
        name="美团",
        aliases=("美团", "美团外卖", "美团闪购", "大众点评"),
        domains=("meituan.com", "dianping.com"),
        query_terms=("美团 官网", "美团 财报", "美团 公告", "美团 帮助中心"),
    ),
    OfficialSourceProfile(
        name="阿里巴巴",
        aliases=("阿里", "阿里巴巴", "淘宝", "淘宝闪购", "饿了么", "飞猪", "盒马"),
        domains=("alibabagroup.com", "taobao.com", "tmall.com", "ele.me", "alibaba.com"),
        query_terms=("Alibaba Businesses", "阿里巴巴 业务介绍", "淘宝闪购 官方", "饿了么 官方"),
    ),
    OfficialSourceProfile(
        name="京东",
        aliases=("京东", "京东外卖", "京东秒送", "达达", "京东到家"),
        domains=("jd.com", "jd.hk", "jdl.com", "imdada.cn"),
        query_terms=("京东 官网", "京东 财报", "京东秒送 官方", "京东外卖 官方"),
    ),
    OfficialSourceProfile(
        name="OpenAI",
        aliases=("OpenAI", "ChatGPT", "GPT", "OpenAI API"),
        domains=("openai.com",),
        query_terms=("OpenAI official", "OpenAI pricing", "OpenAI help center"),
    ),
    OfficialSourceProfile(
        name="DeepSeek",
        aliases=("DeepSeek", "深度求索", "deepseek"),
        domains=("deepseek.com",),
        query_terms=("DeepSeek official", "DeepSeek API pricing", "DeepSeek docs"),
    ),
    OfficialSourceProfile(
        name="Anthropic",
        aliases=("Anthropic", "Claude"),
        domains=("anthropic.com",),
        query_terms=("Anthropic official", "Claude pricing", "Claude docs"),
    ),
    OfficialSourceProfile(
        name="字节跳动",
        aliases=("字节", "字节跳动", "抖音", "火山引擎", "豆包"),
        domains=("bytedance.com", "douyin.com", "volcengine.com", "doubao.com"),
        query_terms=("字节跳动 官网", "抖音 官方", "火山引擎 文档", "豆包 官方"),
    ),
    OfficialSourceProfile(
        name="腾讯",
        aliases=("腾讯", "微信", "腾讯云", "元宝"),
        domains=("tencent.com", "qq.com", "weixin.qq.com", "cloud.tencent.com"),
        query_terms=("腾讯 官网", "腾讯 财报", "腾讯云 文档", "腾讯元宝 官方"),
    ),
    OfficialSourceProfile(
        name="百度",
        aliases=("百度", "文心一言", "ERNIE", "百度智能云"),
        domains=("baidu.com", "baidu-intl.com", "cloud.baidu.com"),
        query_terms=("百度 官网", "百度 财报", "文心一言 官方", "百度智能云 文档"),
    ),
    OfficialSourceProfile(
        name="携程",
        aliases=("携程", "Trip.com", "去哪儿", "同程"),
        domains=("ctrip.com", "trip.com", "qunar.com", "ly.com"),
        query_terms=("携程 官网", "Trip.com investor relations", "去哪儿 官方", "同程 官方"),
    ),
    OfficialSourceProfile(
        name="滴滴",
        aliases=("滴滴", "滴滴出行", "高德", "哈啰"),
        domains=("didiglobal.com", "didichuxing.com", "amap.com", "hello-inc.com"),
        query_terms=("滴滴 官网", "滴滴 财报", "高德 官方", "哈啰 官方"),
    ),
)


def _load_official_source_profiles() -> tuple[OfficialSourceProfile, ...]:
    profile_path = Path(__file__).with_name("official_sources.json")
    if not profile_path.exists():
        return DEFAULT_OFFICIAL_SOURCE_PROFILES

    try:
        payload = json.loads(profile_path.read_text(encoding="utf-8"))
        profiles = []
        for item in payload.get("profiles", []):
            profiles.append(
                OfficialSourceProfile(
                    name=str(item["name"]),
                    aliases=tuple(str(value) for value in item.get("aliases", [])),
                    domains=tuple(str(value).lower().removeprefix("www.") for value in item.get("domains", [])),
                    query_terms=tuple(str(value) for value in item.get("query_terms", [])),
                )
            )
        return tuple(profiles) or DEFAULT_OFFICIAL_SOURCE_PROFILES
    except Exception:
        return DEFAULT_OFFICIAL_SOURCE_PROFILES


OFFICIAL_SOURCE_PROFILES: tuple[OfficialSourceProfile, ...] = _load_official_source_profiles()


AUTHORITY_DOMAINS = (
    "gov.cn",
    "cctv.com",
    "people.com.cn",
    "xinhuanet.com",
    "chinanews.com.cn",
    "thepaper.cn",
    "cyol.com",
    "caixin.com",
    "yicai.com",
    "sec.gov",
    "hkexnews.hk",
)

LOW_CREDIBILITY_DOMAINS = (
    "jianshu.com",
    "juejin.cn",
    "zhihu.com",
    "csdn.net",
    "toutiao.com",
    "baijiahao.baidu.com",
    "sohu.com",
    "163.com",
)


BAD_SOURCE_PATH_PREFIXES = (
    "/clev",
    "/sp/",
    "/sorry/",
)

BAD_SOURCE_SCHEMES = ("javascript", "mailto", "data", "")


def is_competitive_research_task(task: str | None) -> bool:
    return bool(task and COMPETITIVE_MARKER in task)


def _extract_line_value(task: str, label: str) -> str:
    match = re.search(rf"^{re.escape(label)}[:：](.+)$", task, flags=re.MULTILINE)
    return match.group(1).strip() if match else ""


def split_cn_list(value: str) -> list[str]:
    return [item.strip() for item in re.split(r"[、,，\n]", value or "") if item.strip()]


def _extract_line_value(task: str, label: str) -> str:
    match = re.search(rf"^{re.escape(label)}[:：](.+)$", task or "", flags=re.MULTILINE)
    return match.group(1).strip() if match else ""


def split_cn_list(value: str) -> list[str]:
    return [item.strip() for item in re.split(r"[、，,\n]", value or "") if item.strip()]


def _extract_line_value(task: str, label: str) -> str:
    for line in (task or "").splitlines():
        stripped = line.strip()
        for sep in (":", "\uff1a"):
            prefix = f"{label}{sep}"
            if stripped.startswith(prefix):
                return stripped[len(prefix):].strip()
    return ""


def extract_competitive_request(task: str) -> dict[str, object]:
    return {
        "research_topic": _extract_line_value(task, "研究主题"),
        "competitors": split_cn_list(_extract_line_value(task, "竞品范围")),
        "dimensions": split_cn_list(_extract_line_value(task, "研究维度")),
        "region": _extract_line_value(task, "研究地区"),
        "time_range": _extract_line_value(task, "时间范围"),
        "extra_requirements": _extract_line_value(task, "补充要求"),
    }


def extract_competitive_request(task: str) -> dict[str, object]:
    return {
        "research_topic": _extract_line_value(task, "\u7814\u7a76\u4e3b\u9898"),
        "competitors": split_cn_list(_extract_line_value(task, "\u7ade\u54c1\u8303\u56f4")),
        "dimensions": split_cn_list(_extract_line_value(task, "\u7814\u7a76\u7ef4\u5ea6")),
        "region": _extract_line_value(task, "\u7814\u7a76\u5730\u533a"),
        "time_range": _extract_line_value(task, "\u65f6\u95f4\u8303\u56f4"),
        "extra_requirements": _extract_line_value(task, "\u8865\u5145\u8981\u6c42"),
    }


def domain_from_url(url: str) -> str:
    try:
        return urlparse(url).netloc.lower().removeprefix("www.")
    except Exception:
        return ""


def is_usable_source_url(url: str) -> bool:
    parsed = urlparse((url or "").strip())
    if parsed.scheme.lower() in BAD_SOURCE_SCHEMES:
        return False
    if parsed.scheme.lower() not in {"http", "https"}:
        return False
    if not parsed.netloc:
        return False
    path = parsed.path.lower()
    if any(path.startswith(prefix) for prefix in BAD_SOURCE_PATH_PREFIXES):
        return False
    domain = parsed.netloc.lower().removeprefix("www.")
    if domain in {"localhost", "127.0.0.1", "0.0.0.0"}:
        return False
    return True


def filter_usable_source_urls(urls: list[str]) -> list[str]:
    filtered = []
    seen = set()
    for url in urls or []:
        clean_url = str(url or "").strip()
        if not is_usable_source_url(clean_url) or clean_url in seen:
            continue
        seen.add(clean_url)
        filtered.append(clean_url)
    return filtered


def _domain_matches(domain: str, candidates: tuple[str, ...]) -> bool:
    return any(domain == item or domain.endswith(f".{item}") for item in candidates)


def matched_profiles_for_text(text: str) -> list[OfficialSourceProfile]:
    matched = []
    for profile in OFFICIAL_SOURCE_PROFILES:
        if any(alias and alias.lower() in text.lower() for alias in profile.aliases):
            matched.append(profile)
    return matched


def matched_profiles_for_request(request: dict[str, object]) -> dict[str, list[OfficialSourceProfile]]:
    mapping: dict[str, list[OfficialSourceProfile]] = {}
    topic = str(request.get("research_topic") or "")
    competitors = request.get("competitors") or []
    for competitor in competitors:
        competitor_text = f"{topic} {competitor}"
        profiles = matched_profiles_for_text(competitor_text)
        mapping[str(competitor)] = profiles
    return mapping


def official_terms_for_competitor(competitor: str, request: dict[str, object] | None = None) -> str:
    topic = str((request or {}).get("research_topic") or "")
    profiles = matched_profiles_for_text(f"{topic} {competitor}")
    if profiles and profiles[0].query_terms:
        return " ".join(profiles[0].query_terms[:2])
    return f"{competitor} 官网 官方公告 帮助中心 定价 更新日志"


def classify_source_url(url: str) -> dict[str, str]:
    domain = domain_from_url(url)
    matched_profile = next(
        (profile for profile in OFFICIAL_SOURCE_PROFILES if _domain_matches(domain, profile.domains)),
        None,
    )
    if matched_profile:
        return {"tier": "S", "label": "官方来源", "domain": domain, "reason": matched_profile.name}
    if _domain_matches(domain, AUTHORITY_DOMAINS):
        return {"tier": "A", "label": "权威/监管/主流媒体", "domain": domain, "reason": "authority_domain"}
    if _domain_matches(domain, LOW_CREDIBILITY_DOMAINS):
        return {"tier": "C", "label": "社区/自媒体/弱验证来源", "domain": domain, "reason": "low_credibility_domain"}
    return {"tier": "B", "label": "普通公开来源", "domain": domain, "reason": "default"}


def build_source_tier_summary(urls: list[str]) -> dict[str, object]:
    classified = [{"url": url, **classify_source_url(url)} for url in urls]
    counts = {"S": 0, "A": 0, "B": 0, "C": 0}
    for item in classified:
        counts[item["tier"]] += 1
    return {
        "counts": counts,
        "classified_urls": classified,
        "official_urls": [item["url"] for item in classified if item["tier"] == "S"],
    }


def competitor_official_coverage(request: dict[str, object], urls: list[str]) -> dict[str, object]:
    profile_map = matched_profiles_for_request(request)
    coverage = {}
    missing = []
    unknown_profiles = []
    covered = []
    for competitor, profiles in profile_map.items():
        official_urls = []
        for url in urls:
            domain = domain_from_url(url)
            if any(_domain_matches(domain, profile.domains) for profile in profiles):
                official_urls.append(url)
        coverage[competitor] = {
            "matched_profiles": [profile.name for profile in profiles],
            "official_urls": official_urls,
            "has_official_source": bool(official_urls),
            "has_official_profile": bool(profiles),
        }
        if not profiles:
            unknown_profiles.append(competitor)
        elif official_urls:
            covered.append(competitor)
        else:
            missing.append(competitor)
    return {
        "coverage": coverage,
        "covered_competitors": covered,
        "missing_competitors": missing,
        "unknown_profile_competitors": unknown_profiles,
    }


def official_source_query_seeds(task: str, max_queries: int = 2) -> list[str]:
    if not is_competitive_research_task(task):
        return []

    request = extract_competitive_request(task)
    topic = str(request.get("research_topic") or "").strip()
    competitors = [str(item).strip() for item in request.get("competitors") or [] if str(item).strip()]
    profile_map = matched_profiles_for_request(request)

    queries = []
    if competitors:
        queries.append(
            f"{topic} {' '.join(competitors[:4])} 官方 来源 母公司 品牌关系 收购 更名 业务介绍"
        )

    matched_profiles = []
    seen_profile_names = set()
    for profiles in profile_map.values():
        for profile in profiles:
            if profile.name not in seen_profile_names:
                seen_profile_names.add(profile.name)
                matched_profiles.append(profile)
    if matched_profiles:
        profile_terms = " ".join(profile.query_terms[0] for profile in matched_profiles[:4])
        queries.append(f"{topic} {profile_terms} 官方公告 财报 帮助中心 定价 会员")

    for competitor in competitors:
        profiles = profile_map.get(competitor) or []
        if profiles:
            profile_terms = " ".join(profiles[0].query_terms[:2])
            queries.append(f"{competitor} {profile_terms} 官方 公告 帮助中心 定价 会员")
        else:
            queries.append(f"{competitor} 官网 官方公告 帮助中心 定价 会员 产品更新")

    deduped = []
    seen = set()
    for query in queries:
        normalized = " ".join(query.split())
        if normalized and normalized not in seen:
            seen.add(normalized)
            deduped.append(normalized)
        if len(deduped) >= max_queries:
            break
    return deduped


def enrich_sub_queries_with_official_sources(
    task: str,
    sub_queries: list[str],
    max_total: int = 6,
    max_official_queries: int = 2,
) -> list[str]:
    if not is_competitive_research_task(task):
        return sub_queries

    merged = []
    seen = set()
    for query in [*official_source_query_seeds(task, max_official_queries), *sub_queries]:
        clean_query = query.strip()
        if not clean_query or clean_query in seen:
            continue
        seen.add(clean_query)
        merged.append(clean_query)
        if len(merged) >= max_total:
            break
    return merged
