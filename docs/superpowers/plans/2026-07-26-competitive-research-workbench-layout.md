# 竞研 Agent Workbench Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the existing frontend UI into a workbench layout with a scrollable left configuration panel, collapsible research progress rail, and right report/chat workspace.

**Architecture:** Keep existing DOM IDs and data flow stable, and move existing blocks rather than rebuilding controls. Add only lightweight layout containers, workspace tab controls, and progress rail collapse behavior. WebSocket handling, report rendering, history, downloads, and chat APIs remain unchanged.

**Tech Stack:** Static HTML, CSS, vanilla JavaScript, Node-based static verification, FastAPI static server.

---

## Files

- Modify: `E:\ai竞品研究agent\gpt-researcher\frontend\index.html`
- Modify: `E:\ai竞品研究agent\gpt-researcher\frontend\styles.css`
- Modify: `E:\ai竞品研究agent\gpt-researcher\frontend\scripts.js`
- Create: `E:\ai竞品研究agent\gpt-researcher\tests\workbench_layout_check.js`

## Task 1: Static Layout Contract

- [ ] **Step 1: Create a Node static verification script**

Create `tests/workbench_layout_check.js` that reads `frontend/index.html` and `frontend/scripts.js`, then checks:

```js
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'frontend', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'frontend', 'scripts.js'), 'utf8');

function has(pattern, message) {
  assert(pattern.test(html), message);
}

function hasJs(pattern, message) {
  assert(pattern.test(js), message);
}

has(/class="[^"]*app-workbench[^"]*"/, 'app workbench shell should exist');
has(/class="[^"]*research-config-panel[^"]*"/, 'left config panel should exist');
has(/class="[^"]*progress-rail[^"]*"/, 'research progress rail should exist');
has(/class="[^"]*workspace-panel[^"]*"/, 'right workspace panel should exist');
has(/data-workspace-tab="report"/, 'report workspace tab should exist');
has(/data-workspace-tab="chat"/, 'chat workspace tab should exist');
has(/研究进度/, 'progress label should be 研究进度');
assert(!html.includes('运行状态'), '运行状态 wording should not be present');
has(/id="competitors"[^>]*type="text"/, 'competitors should remain a text input');
has(/id="submitButton"[^>]*value="开始研究"/, 'submit button should keep text-only label');
hasJs(/initWorkspaceTabs/, 'workspace tab initializer should exist');
hasJs(/initProgressRail/, 'progress rail initializer should exist');
hasJs(/expandProgressRail/, 'startResearch should be able to expand progress rail');

console.log('workbench layout contract passed');
```

- [ ] **Step 2: Run script and confirm it fails before implementation**

Run:

```powershell
node tests\workbench_layout_check.js
```

Expected: failure mentioning missing `app workbench shell`.

## Task 2: HTML Component Migration

- [ ] **Step 1: Replace the large `landing` + single-column `main.container` structure**

Move existing form, progress, report, and chat blocks into this structure while keeping the original IDs:

```html
<main class="app-workbench" id="form">
  <section class="research-config-panel">
    <div class="agent-item">...</div>
    <div class="agent-heading">...</div>
    <form id="researchForm">...</form>
  </section>
  <aside class="progress-rail is-open" id="progressRail">...</aside>
  <section class="workspace-panel">...</section>
</main>
```

- [ ] **Step 2: Keep the complete `#researchForm` contents**

Do not remove supported fields:

```text
#task
#researchTopic
#competitors
#region
#timeRange
name="competitive_dimension"
#extraRequirements
#report_type
#tone
#report_source
#maxSearchResults
#queryDomains
#submitButton
```

- [ ] **Step 3: Move `.research-output-container` into `#progressRail`**

Add a collapse button:

```html
<button type="button" id="progressRailToggle" class="progress-rail-toggle" title="收起研究进度">收起</button>
```

- [ ] **Step 4: Move `.report-container` and `#chatContainer` into `.workspace-panel`**

Add tab buttons:

```html
<button type="button" class="workspace-tab is-active" data-workspace-tab="report">研究报告</button>
<button type="button" class="workspace-tab" data-workspace-tab="chat">继续追问</button>
```

Wrap existing report/chat containers:

```html
<div class="workspace-view is-active" data-workspace-view="report">...</div>
<div class="workspace-view" data-workspace-view="chat">...</div>
```

## Task 3: Minimal CSS Layout

- [ ] **Step 1: Add workbench layout rules**

Append rules for `.app-workbench`, `.research-config-panel`, `.progress-rail`, and `.workspace-panel`. Use grid on desktop and stacked layout on mobile.

- [ ] **Step 2: Add left panel scroll**

Set:

```css
.research-config-panel {
  max-height: calc(100svh - 48px);
  overflow-y: auto;
}
```

- [ ] **Step 3: Add progress rail collapsed state**

Use class `.progress-rail.is-collapsed` to reduce width and hide body content without removing the DOM.

- [ ] **Step 4: Add workspace view switching styles**

Use `.workspace-view { display: none; }` and `.workspace-view.is-active { display: block; }`.

## Task 4: JavaScript Interaction

- [ ] **Step 1: Add `initWorkspaceTabs()`**

Bind `[data-workspace-tab]` to show matching `[data-workspace-view]`.

- [ ] **Step 2: Add `initProgressRail()`**

Bind `#progressRailToggle` to toggle `.is-collapsed` on `#progressRail`.

- [ ] **Step 3: Add `expandProgressRail()`**

Remove `.is-collapsed` at the start of a new research run.

- [ ] **Step 4: Call initializers from `init()`**

Add `initWorkspaceTabs()` and `initProgressRail()` near the other UI initializers.

- [ ] **Step 5: Replace research progress scroll behavior**

In `startResearch()`, call `expandProgressRail()` instead of scrolling the page to `.research-output-container`.

## Task 5: Verification

- [ ] **Step 1: Run syntax check**

```powershell
node --check frontend\scripts.js
```

Expected: no output and exit code 0.

- [ ] **Step 2: Run static layout contract**

```powershell
node tests\workbench_layout_check.js
```

Expected:

```text
workbench layout contract passed
```

- [ ] **Step 3: Run Git whitespace check**

```powershell
git diff --check -- frontend/index.html frontend/styles.css frontend/scripts.js tests/workbench_layout_check.js
```

Expected: no output and exit code 0.

- [ ] **Step 4: Browser smoke check**

Reload `http://127.0.0.1:8000/` and verify:

```text
左侧配置区存在且可滚动
研究进度侧栏可收起和展开
右侧存在研究报告/继续追问两个 tab
状态/历史按钮仍在右上角
无运行状态文案
无高级设置文案
竞品名称仍为文本输入
开始研究无 icon
```

