# AI 产品竞品研究 Agent

基于开源项目 [GPT Researcher](https://github.com/assafelovic/gpt-researcher) 改造的 AI 产品竞品研究 Agent 原型。项目目标是把通用深度研究能力产品化为“产品经理可用的竞品研究工具”：用户输入研究主题、竞品、维度、地区和时间范围后，系统自动拆解研究问题、搜索和抓取公开资料、评估证据缺口、必要时受控补搜，并生成结构化竞品报告。

本项目用于 AI 产品/产品经理实习简历展示，重点不是从零实现搜索或爬虫，而是在开源深度研究底座上完成垂类产品化、受控工具调用、证据管理、质量评估、补救闭环、持久化和评测复盘。

## 项目价值

竞品研究常见问题：

- 信息分散，人工检索成本高；
- 不同竞品对比口径不一致；
- 近期更新和历史背景容易混在一起；
- 报告引用不一定能支撑结论；
- AI 输出质量难以评估和复盘。

本项目的改造重点：

- 用结构化输入约束研究范围；
- 用竞品研究 Prompt 固定报告结构和对比口径；
- 用 Evaluator 检查竞品覆盖、维度覆盖、官方来源和时间范围风险；
- 用受控工具调用在证据缺口较高时补搜一轮；
- 用 Evidence Ledger 管理竞品、维度、事实、来源和时间信息；
- 用 MySQL/本地 JSON 保存报告和历史；
- 用真实任务评测和 Badcase 记录证明迭代过程。

## 核心功能

- 中文竞品研究 UI：研究主题、竞品范围、研究维度、地区、时间范围、补充要求。
- 自动研究链路：Planner 子问题生成、Web 搜索、网页抓取、摘要压缩、报告生成。
- Agent 闭环：Evaluator 评估证据缺口，Repair Planner 生成补搜工具调用，Tool Executor 受控执行搜索、抓取和证据抽取。
- 标准竞品报告：研究范围、主体关系、竞品概览、定位用户、功能矩阵、商业化、近期更新、差异优势、机会点、限制和来源。
- 研究过程摘要：子问题、来源 URL、章节完整率、矩阵覆盖率、来源分级、Agent trace、补救动作和证据增量。
- 基础竞品矩阵：按竞品 x 维度从报告中提取摘要，支持结构化表格展示。
- 来源质量提示：S/A/B/C 来源分级、官方来源覆盖、低质量来源风险。
- 历史记录：报告正文、下载链接、竞品分析 metadata 持久化。
- 导出能力：Markdown 和 Word 已验证可下载；PDF 在当前 Windows 环境下暂缓。

## 技术栈

- 后端：FastAPI、GPT Researcher、SQLAlchemy、PyMySQL
- 前端：HTML/CSS/JavaScript
- LLM：DeepSeek API
- 搜索：DuckDuckGo 无 Key 搜索
- Embedding：Ollama `nomic-embed-text`
- 存储：MySQL；未配置时可回退到本地 JSON
- 导出：Markdown、Word

## 本地启动

进入项目目录：

```powershell
cd E:\ai竞品研究agent\gpt-researcher
```

启动后端：

```powershell
python -m uvicorn main:app --host 127.0.0.1 --port 8000
```

访问：

```text
http://127.0.0.1:8000/
```

后台启动：

```powershell
cd E:\ai竞品研究agent\gpt-researcher
$p = Start-Process -FilePath python -ArgumentList '-m','uvicorn','main:app','--host','127.0.0.1','--port','8000' -WindowStyle Hidden -PassThru
Set-Content -LiteralPath '.gptr-dev.pid' -Value $p.Id
```

停止后台服务：

```powershell
cd E:\ai竞品研究agent\gpt-researcher
$pidValue = Get-Content .gptr-dev.pid
Stop-Process -Id ([int]$pidValue) -Force
Remove-Item .gptr-dev.pid
```

## 环境配置

`.env` 推荐配置：

```env
FAST_LLM=deepseek:deepseek-chat
SMART_LLM=deepseek:deepseek-chat
STRATEGIC_LLM=deepseek:deepseek-chat
DEEPSEEK_API_KEY=你的 DeepSeek Key

RETRIEVER=duckduckgo

EMBEDDING=ollama:nomic-embed-text
OLLAMA_BASE_URL=http://localhost:11434

DATABASE_URL=mysql+pymysql://root:你的密码@localhost:3306/gpt_researcher?charset=utf8mb4
LANGUAGE=chinese
```

Ollama embedding 模型：

```powershell
ollama pull nomic-embed-text
```

如果不配置 `DATABASE_URL`，报告历史会回退到本地 `data/reports.json`。

## 用户 Query 到报告的流程

```text
结构化输入
→ 前端校验并拼接竞品研究任务
→ Planner 生成子问题
→ 搜索器检索公开网页
→ 抓取网页内容
→ 网页切块和 embedding 相关性过滤
→ 聚合上下文
→ Evaluator 检查竞品/维度/官方来源/时间范围缺口
→ 如有高优先级缺口，Repair Planner 输出受控工具调用
→ Tool Executor 最多补搜一轮并更新 Evidence Ledger
→ LLM 生成竞品研究报告
→ 后处理生成矩阵、来源分级、章节检查和风险提示
→ 前端展示报告、矩阵、下载按钮和历史记录
```

LLM 负责研究规划、补救工具意图和报告生成；搜索器和 Scraper 负责外部资料获取；embedding 负责相关内容筛选；确定性代码负责工具白名单校验、质量评估、证据台账、矩阵提取、来源统计、风险提示和历史持久化。

## 主要改造点

- 结构化竞品研究输入：把自由文本研究任务产品化为固定字段。
- 竞品研究 Prompt：要求统一维度、主体关系校验、官方来源优先、缺失信息标注。
- Agent repair loop：在首次研究后评估证据缺口，并最多触发一轮受控补搜。
- Evidence Ledger：沉淀竞品、维度、事实摘要、来源 URL、来源等级、官方倾向和时间提示。
- 报告结构约束：让输出更接近产品经理可读的竞品研究报告。
- 基础竞品矩阵：从最终报告中抽取竞品 x 维度摘要。
- 来源分级：按 S/A/B/C 标记官方、权威、普通和弱验证来源。
- 持久化：报告正文、下载路径和竞品分析 metadata 保存到 MySQL。
- 评测体系：深测、冒烟、泛化测试和 Badcase 复盘。

## 模型和工具选型

当前本地 Demo 选型：

| 模块 | 当前选择 | 选择原因 | 主要限制 |
|---|---|---|---|
| Planner/Writer/Repair LLM | `deepseek:deepseek-chat` | 中文能力、成本和可用性适合本地 Demo；统一模型降低配置复杂度 | 推理和工具调用稳定性弱于更强模型，生产环境可拆分 Planner/Evaluator/Writer 模型 |
| Embedding | `ollama:nomic-embed-text` | 本地运行、无需额外 API Key、适合 query 与网页 chunk 的语义相关性筛选 | 召回质量可能弱于商业 embedding |
| 搜索器 | `duckduckgo` | 无需 API Key，启动成本低，适合演示 | 官方来源召回不稳定，生产环境可替换 Tavily、Serper、Bing Search |
| Scraper | `bs` | BeautifulSoup 静态抓取轻量、依赖少 | 动态网页、登录内容和复杂反爬页面抓取能力有限 |

面试表述：首版选择不是追求最强模型，而是为了快速跑通低成本 Demo；评测发现 DuckDuckGo 官方来源召回不足后，补了 Evaluator + repair search 策略。生产环境可以把搜索器换成更稳定的商业搜索 API，把 Planner/Evaluator 换成更强推理模型。

## 评测结果

当前累计真实评测/复测记录：10 次 Run。

评测集：

- 13 条分层测试任务；
- 9 个中国场景，4 个全球场景；
- 3 条 AI 产品深测；
- 3 条扩展冒烟；
- 1 条非 AI 行业泛化测试；
- 记录 8 个 Badcase。

深测结果：

| 指标 | 结果 |
|---|---:|
| 深测任务数 | 3 |
| 任务完成率 | 3/3 |
| Markdown 下载通过率 | 3/3 |
| Word 下载通过率 | 3/3 |
| 历史保存/读取通过率 | 3/3 |
| 平均章节完整率 | 0.9697 |
| 修复后平均矩阵覆盖率 | 0.9815 |
| S 级官方来源总数 | 4 |

冒烟结果：

| 指标 | 结果 |
|---|---:|
| 冒烟任务数 | 3 |
| 任务完成率 | 3/3 |
| Markdown 下载通过率 | 3/3 |
| Word 下载通过率 | 3/3 |
| 历史保存/读取通过率 | 3/3 |
| 平均章节完整率 | 0.9697 |
| 平均矩阵覆盖率 | 0.8889 |

详细记录见：

- `evals/competitive_research_tasks.json`
- `evals/competitive_research_evaluation.md`
- `E:\ai竞品研究agent\docs\项目计划与进度.md`
- `E:\ai竞品研究agent\docs\防面试被拷打的项目笔记.md`

## 典型 Badcase

- 官方来源召回不足：搜索结果仍偏第三方媒体，S 级官方来源不稳定。
- 竞品覆盖不均：某个竞品资料不足时，报告对比完整性下降，已补 Evaluator + repair search 闭环。
- 时间范围口径不严格：最近 6 个月任务仍可能混入 2025 年信息。
- 标题泛化问题：早期非 AI 行业任务仍输出“AI 产品竞品研究报告”，已修复。
- 主体关系不清：饿了么/淘宝闪购关系未说明，已通过主体关系章节改善。
- 矩阵内容重复：旧后处理命中报告总述段，已改为章节/表格优先提取。
- 竞品名格式不一致：空格差异导致矩阵 missing，已做空格归一化。
- 搜索结果污染：候选来源中可能出现明显无关或低质量 URL。

## 已知限制

- 不保证所有事实完全准确，关键结论仍需人工抽样核验。
- 官方来源召回依赖搜索器和网页可抓取性，目前只能做提示和分级，不能保证每个竞品都有官方来源。
- Agent repair loop 最多补救一轮，目标是提高可控性和可解释性，不保证补搜一定找到可靠来源。
- “最近 6 个月”等时效口径仍需更强的日期过滤。
- PDF 导出在当前 Windows 环境受 WeasyPrint 依赖影响，暂不作为核心交付。
- 追问功能是基于当前报告内容的问答，不会重新联网搜索，也不是跨报告知识库。
- 本项目是本地 Demo，暂未做线上部署、登录权限和多人协作。

## 面试表述边界

可以说：

- 基于 GPT Researcher 改造了一个 AI 产品竞品研究 Agent；
- 复用了其搜索、抓取、并发研究、上下文聚合和报告生成能力；
- 自己完成了竞品研究场景定义、结构化输入、Prompt 改造、受控工具调用、证据台账、Evaluator 补救闭环、来源分级、MySQL 持久化和评测体系；
- 首版评测发现官方来源不足和竞品覆盖不均后，基于 Badcase 补了 evaluator-driven repair loop；
- 用真实任务完成了深测、冒烟和 Badcase 复盘。

不要说：

- 从零实现了搜索引擎；
- 从零实现了网页爬虫；
- 从零实现了完整深度研究 Agent；
- 实现了完整 ReAct、多 Agent 协作或长期记忆；
- 已经解决所有事实准确性和官方来源问题；
- 做了大规模 Benchmark 或线上生产级评测。
