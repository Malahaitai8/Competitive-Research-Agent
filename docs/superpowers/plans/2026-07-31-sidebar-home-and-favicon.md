# Sidebar Home Action and Professional Favicon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent sidebar action that returns to the welcome view and replace the browser favicon with the existing professional cat IP.

**Architecture:** Reuse the existing single-shell `setWorkbenchView` and `syncTaskUrl` state controller instead of adding navigation. Add one semantic button to the sidebar footer and point both favicon link relations at the existing professional cat image.

**Tech Stack:** Static HTML, CSS, vanilla JavaScript, Node assertion-based layout regression.

---

### Task 1: Add regression assertions

**Files:**
- Modify: `tests/workbench_layout_check.js`

- [ ] **Step 1: Write the failing assertions**

```js
assert(indexHtml.includes('id="sidebarHomeButton"'), 'sidebar should expose a return-home action');
assert(indexHtml.includes('href="/static/jingyan-agent-cat-professional.png?v=3"'), 'favicon should reuse the professional cat IP');
assert(!indexHtml.includes('jingyan-agent-cat-favicon'), 'legacy childlike favicon should be removed');
assert(scriptsJs.includes("document.getElementById('sidebarHomeButton')?.addEventListener('click'"), 'home action should be wired through the workbench controller');
assert(stylesCss.includes('.sidebar-home-button'), 'home action should have scoped sidebar styling');
```

- [ ] **Step 2: Run the test to verify RED**

Run: `node tests/workbench_layout_check.js`

Expected: FAIL because `sidebarHomeButton` does not exist.

### Task 2: Implement the sidebar home action and favicon

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/scripts.js`
- Modify: `frontend/styles.css`

- [ ] **Step 1: Add the semantic sidebar footer button**

Insert after `#workbenchHistory`:

```html
<div class="sidebar-footer">
    <button type="button" class="sidebar-home-button" id="sidebarHomeButton" aria-label="返回主页" title="返回主页">
        <i class="fas fa-house" aria-hidden="true"></i>
        <span>返回主页</span>
    </button>
</div>
```

- [ ] **Step 2: Wire the existing state controller**

Add in `initWorkbench`:

```js
document.getElementById('sidebarHomeButton')?.addEventListener('click', () => {
  setWorkbenchView('welcome');
  document.body.classList.remove('sidebar-open');
});
```

- [ ] **Step 3: Add restrained responsive styling**

```css
.sidebar-home-button {
    color: var(--workbench-muted);
    border: 0;
    border-radius: 7px;
    background: transparent;
}

.sidebar-home-button:hover,
.sidebar-home-button:focus-visible {
    color: var(--workbench-accent-dark);
    background: var(--workbench-accent-soft);
    outline: 0;
}
```

Keep the existing collapsed-sidebar footer rules so only the icon remains visible.

- [ ] **Step 4: Replace both favicon links**

```html
<link rel="icon" type="image/png" href="/static/jingyan-agent-cat-professional.png?v=3">
<link rel="shortcut icon" type="image/png" href="/static/jingyan-agent-cat-professional.png?v=3">
```

- [ ] **Step 5: Run regression checks**

Run: `node tests/workbench_layout_check.js`

Expected: `workbench_layout_check passed`

Run: `node --check frontend/scripts.js`

Expected: exit code 0.

Run: `git diff --check`

Expected: no whitespace errors.

### Task 3: Browser smoke test

**Files:**
- No source changes expected.

- [ ] **Step 1: Reload the current local page**

Verify the browser loads `/static/jingyan-agent-cat-professional.png?v=3` as the favicon.

- [ ] **Step 2: Verify return-home behavior**

Open a completed history task, click “返回主页”, then verify:

- welcome heading is visible;
- the `#task=...` hash is removed;
- history items remain present;
- mobile sidebar open state is cleared.
