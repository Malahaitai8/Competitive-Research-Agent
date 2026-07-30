# 竞研 Agent 工作台布局设计规格

**目标：** 将当前纵向滚动页面调整为更适合竞品调研操作的工作台布局，让配置、研究进度、研究报告和继续追问在同一屏内分区展示，同时保留现有产品功能和已定 UI 质感。

**设计原则：** 以移动现有组件为主，只补充必要的布局容器和折叠交互。已有表单控件、多选维度样式、报告展示样式、历史面板样式、状态面板样式不做大规模重写。

**适用范围：** 仅涉及 `frontend/index.html`、`frontend/styles.css`、`frontend/scripts.js` 的布局组织和少量交互绑定。后端、研究流程、WebSocket 数据结构、报告生成逻辑不纳入本次改造。

---

## 已确认需求和偏好

1. 页面应从“向下滚动才能看到进度和报告”的结构，改为分版块工作台结构。
2. 左侧配置区允许独立滚动，避免长表单把整页撑得过高。
3. 左侧按钮、下拉框、输入框、多选维度继续使用当前版本样式，不增加新的视觉体系。
4. 不增加当前版本不支持的字段，不出现“高级设置”。
5. “开始研究”按钮前不加 icon。
6. 左侧小标题文字前不加 icon。
7. 右上角“状态”按钮保留，它表示连接/系统状态；不与研究进度冲突。
8. “运行状态”统一改为“研究进度”。
9. “研究进度”不放在右侧 tab 里，而是做成可展开/收起的独立侧栏。
10. 右侧主工作区只展示当前已支持的信息：研究报告、继续追问、下载/复制/展开等已有操作。
11. 小猫头像和浅粉蓝配色保留，但头像不应遮挡耳朵。
12. 本次实施前需要能回退到当前版本。

## 当前页面组件盘点

| 当前组件 | 当前位置 | 现有功能 | 改造策略 |
| --- | --- | --- | --- |
| `nav-buttons` | 页面右上角 | 打开“状态”和“历史”抽屉 | 保留在右上角，不移入主工作台 |
| `landing` | 页面顶部 hero | 标题、描述、开始研究锚点 | 从主操作流中弱化或移除高 hero 高度；品牌信息压缩进左侧配置区顶部 |
| `.agent-item` + `.avatar` | 表单容器顶部 | 小猫头像展示 | 移到左侧配置区顶部，保留耳朵外露空间 |
| `#researchForm` | 主容器内纵向排列 | 研究任务和参数配置 | 移入左侧配置区，配置区独立滚动 |
| `.competitive-research-panel` | 表单内 | 研究主题、竞品名称、地区、时间、维度、补充要求 | 保留原字段和原控件类型，仅随左侧宽度调整排列 |
| `#report_type` | 表单内 | 报告类型选择 | 保留在左侧配置区 |
| `#tone` | 表单内 | 报告语气选择 | 保留在左侧配置区 |
| `#report_source` | 表单内 | 研究来源选择 | 保留在左侧配置区 |
| `#maxSearchResults` | 表单内 | 每个搜索问题抓取网页数量 | 保留在左侧配置区 |
| `#queryDomains` | 表单内 | 限定搜索域名 | 保留在左侧配置区 |
| `#submitButton` | 表单底部 | 开始研究 | 保留文字按钮，无 icon，可固定在左侧底部或跟随表单底部 |
| `.research-output-container` + `#output` | 表单下方 | WebSocket 日志、子问题、搜索/抓取/分析过程 | 移入“研究进度”可收起侧栏 |
| `.report-container` + `#reportContainer` | 进度下方 | 流式报告、分析摘要、下载、复制、展开 | 移入右侧主工作区的“研究报告”视图 |
| `#chatContainer` | 报告下方，完成后显示 | 围绕报告继续追问 | 移入右侧主工作区的“继续追问”视图，沿用完成后显示逻辑 |
| `#historyPanel` | 右侧抽屉 | 历史记录搜索、导入导出、下载 | 保持抽屉，不改成工作台 tab |
| WebSocket 状态面板 | 抽屉 | 连接状态、消息统计、当前任务 | 保持由右上角“状态”按钮打开 |
| `.sticky-downloads-bar` | 页面底部固定栏 | 下载入口 | 保留，不改变下载数据来源 |

## 目标布局

桌面端使用三块工作区：

1. **左侧配置区**
   - 固定宽度约 360-420px。
   - 高度接近视口高度，内部 `overflow-y: auto`。
   - 顶部展示小猫头像、`竞研 Agent` 名称和一句简短说明。
   - 下面放原 `#researchForm` 内全部已支持字段。
   - 不新增字段，不把 `竞品名称` 改成下拉框。

2. **中间研究进度侧栏**
   - 默认展开时宽度约 280-340px。
   - 标题为“研究进度”。
   - 承载原 `.research-output-container`、`#modernSpinner`、`#expandOutputBtn`、`#output`。
   - 支持收起为一条窄栏，窄栏仍显示“研究进度”文字或方向按钮，方便随时展开。
   - 收起状态不影响 WebSocket 日志写入，只改变显示宽度。

3. **右侧主工作区**
   - 占用剩余宽度。
   - 顶部使用轻量 tab 或按钮切换：`研究报告`、`继续追问`。
   - `研究报告`视图承载原 `.report-container`。
   - `继续追问`视图承载原 `#chatContainer`。
   - 不增加“市场份额”“成功率”“预计剩余时间”等当前数据源不支持的信息。

移动端使用纵向顺序：

1. 顶部仍保留“状态”“历史”按钮。
2. 左侧配置区变为顶部配置卡，允许自然滚动。
3. 研究进度侧栏变为可展开的折叠面板。
4. 右侧主工作区变为下方 tab 区。

## 组件迁移规则

### HTML 迁移

1. 新增一个外层工作台容器，例如 `.app-workbench`，包裹配置区、进度侧栏和主工作区。
2. 将原 `#researchForm` 整体移动到配置区，不拆散字段。
3. 将原 `.research-output-container` 整体移动到研究进度侧栏。
4. 将原 `.report-container` 整体移动到主工作区的报告面板。
5. 将原 `#chatContainer` 整体移动到主工作区的追问面板。
6. 保持所有关键 ID 不变：`#researchForm`、`#task`、`#researchTopic`、`#competitors`、`#region`、`#timeRange`、`#submitButton`、`#output`、`#reportContainer`、`#chatContainer`、`#chatMessages`、`#historyPanel`。
7. 保持隐藏的 `#competitiveMode`，继续默认走结构化竞品研究模式。
8. 原 `landing` 不再占据大块首屏空间；可删除或压缩为配置区顶部品牌区。

### CSS 调整

1. 新增布局类：`.app-workbench`、`.research-config-panel`、`.progress-rail`、`.workspace-panel`、`.workspace-tabs`。
2. 只为新布局容器设置尺寸、间距、滚动和响应式规则。
3. 不重写 `.dimension-option` 的核心视觉样式。
4. 不重写 `#reportContainer`、`.analysis-summary-panel`、`.agent-trace-panel`、`.analysis-matrix` 的核心展示样式。
5. 不把页面改成大量新卡片；工作区可以有清晰边界，但避免卡片套卡片。
6. 左侧配置区应有稳定高度和滚动条，避免页面整体因表单过长被撑开。

### JavaScript 调整

1. 增加主工作区 tab 切换逻辑，仅控制报告区和追问区的显示。
2. 增加研究进度侧栏展开/收起逻辑，仅切换 class，不清空 `#output`。
3. `startResearch()` 开始时自动展开研究进度侧栏，便于看到实时过程。
4. 当前 `startResearch()` 中滚动到 `.research-output-container` 的逻辑需要改为聚焦/展开进度侧栏，避免三栏布局下不必要的整页滚动。
5. `updateState('finished')` 后继续保持现有报告和追问显示逻辑；如需切换 tab，默认停留在“研究报告”。
6. `initExpandButtons()` 的报告、追问、进度全屏展开功能继续保留。
7. 不改 WebSocket 消息处理，不改 `logs`、`report`、`path`、`chat` 的数据分发。

## 存档策略

在实施布局改造前，建议先创建当前前端状态快照。推荐做法是使用 Git checkpoint，而不是手工复制目录。

推荐步骤：

```powershell
git -C "E:\ai竞品研究agent\gpt-researcher" status --short
git -C "E:\ai竞品研究agent\gpt-researcher" add frontend/index.html frontend/styles.css frontend/scripts.js frontend/static/favicon.ico frontend/static/jingyan-agent-cat.png frontend/static/jingyan-agent-cat-favicon.png frontend/static/jingyan-agent-cat-favicon.ico
git -C "E:\ai竞品研究agent\gpt-researcher" commit -m "checkpoint: current competitive research UI"
git -C "E:\ai竞品研究agent\gpt-researcher" tag ui-before-workbench-layout
```

如果希望保存后端竞品研究能力的当前状态，也可以在确认 `git status --short` 里的文件都属于本项目有效变更后，使用一次完整 checkpoint。完整 checkpoint 需要先确认不会把临时文件、密钥或无关实验文件提交进去。

## 不做事项

1. 不改后端接口。
2. 不改 DeepSeek 配置。
3. 不新增研究字段。
4. 不新增“高级设置”。
5. 不把研究进度做成右侧 tab。
6. 不删除右上角“状态”按钮。
7. 不重做报告样式。
8. 不重做研究维度多选样式。
9. 不改变历史面板的功能结构。
10. 不改变历史、下载、复制、展开的既有数据来源。

## 验收标准

1. 首屏能同时看到配置区、研究进度入口、报告/追问主工作区。
2. 左侧配置区可以独立滚动，页面整体不再依赖长距离下滑查看关键区域。
3. “研究进度”可展开和收起，收起后日志仍继续写入。
4. 右上角“状态”和“历史”按钮仍可打开原面板。
5. “研究报告”和“继续追问”只展示当前前端已经支持的内容。
6. 点击“开始研究”后，原研究请求、WebSocket 流式输出、报告渲染、历史保存、下载链接、追问入口都保持可用。
7. `#competitors` 仍是逗号分隔文本输入，不变成下拉框。
8. “开始研究”按钮没有 icon。
9. 页面无“运行状态”文案，统一为“研究进度”。
10. 页面无“高级设置”。

## 建议实施顺序

1. 先创建当前 UI checkpoint。
2. 只改 HTML 结构，将现有组件移动到三栏工作台。
3. 补充最小 CSS 布局规则，让三栏在桌面端成立，移动端退回纵向。
4. 补充研究进度收起/展开和报告/追问 tab 切换。
5. 调整 `startResearch()` 的滚动行为为展开研究进度侧栏。
6. 用浏览器检查桌面端和移动端布局。
7. 跑一次最小研究流程，确认流式进度、报告、历史和下载没有被破坏。

