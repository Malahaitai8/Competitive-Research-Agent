# Browser Refresh Research Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep a research task running when its browser WebSocket disconnects, and restore its stage, logs, and final report after refresh.

**Architecture:** Add an in-process `ResearchTaskRegistry` owned by `WebSocketManager`. Each task runs against a registry-backed event sink instead of a browser socket, while browser connections subscribe and receive a snapshot plus replayed events. The frontend persists only the backend-issued task ID and resubscribes after reload.

**Tech Stack:** Python 3.13, asyncio, FastAPI WebSocket, vanilla JavaScript, pytest, Node static regression checks.

---

### Task 1: Backend task registry

**Files:**
- Create: `backend/server/research_task_registry.py`
- Create: `tests/test_research_task_registry.py`

- [ ] Write async tests proving task creation returns a real ID, disconnection does not cancel execution, replay restores buffered events, completed tasks retain paths, and unknown IDs return `task_not_found`.
- [ ] Run `python -m pytest tests/test_research_task_registry.py -q` and confirm the tests fail because the registry does not exist.
- [ ] Implement `ResearchTaskRecord`, `ResearchTaskEventSink`, and `ResearchTaskRegistry` with bounded event replay, subscribers, status/stage tracking, background execution, completion and failure snapshots.
- [ ] Run the focused test and confirm it passes.

### Task 2: WebSocket lifecycle integration

**Files:**
- Modify: `backend/server/websocket_manager.py`
- Modify: `backend/server/server_utils.py`
- Create: `tests/test_research_task_websocket_resume.py`

- [ ] Write tests proving `start` registers a detached research task, `subscribe` replays it, and the connection cleanup unsubscribes without cancelling it.
- [ ] Run the new tests and confirm the old WebSocket-bound implementation fails them.
- [ ] Give every `WebSocketManager` a registry.
- [ ] Route `start` through `registry.create_task(...)`, route `subscribe` through `registry.subscribe(...)`, and remove research cancellation from connection cleanup.
- [ ] Return generated file paths from `handle_start_command` while keeping all existing message formats and report generation calls.
- [ ] Run backend WebSocket and progress tests.

### Task 3: Frontend task acceptance and recovery

**Files:**
- Modify: `frontend/scripts.js`
- Modify: `tests/workbench_layout_check.js`

- [ ] Add static regression assertions for a versioned active-task storage key, `task_accepted`, `task_snapshot`, `task_not_found`, and `subscribe`.
- [ ] Run `node tests/workbench_layout_check.js` and confirm those assertions fail.
- [ ] Store a pending task only in memory until `task_accepted`.
- [ ] Persist the real task ID, title, timestamp, status, and current stage.
- [ ] On page load or socket reconnect, send `subscribe` instead of `start`.
- [ ] Restore stage/log replay without duplicating messages; clear recovery state on completion, failure, deletion, or `task_not_found`.
- [ ] Keep reconnecting on connection loss instead of marking a running research task failed.
- [ ] Run JavaScript syntax and layout checks.

### Task 4: Full verification and current workflow audit

**Files:**
- Verify only.

- [ ] Run focused backend tests, competitive workflow tests, frontend layout test, JavaScript syntax check, and `git diff --check`.
- [ ] Restart the backend so it loads the new registry.
- [ ] Start a new competitive research task in the browser, record its real task ID, refresh while it is running, and verify restored stage/logs.
- [ ] Verify the final log contains `competitor_normalization`, `agent_evaluation`, `agent_repair_summary`, `semantic_validation_summary`, and `semantic_remediation_summary`.
- [ ] Verify the report uses the required 11-section structure and a `_competitive_analysis.json` file is generated.
- [ ] Report any remaining workflow mismatch with concrete evidence rather than treating a partial run as success.

