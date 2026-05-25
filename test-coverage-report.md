# Test Coverage Report — meatbag-mcp Swarm Synthesis

Generated: 2026-05-25  
Test runner: vitest 3.x with @vitest/coverage-v8  
Command: `npm run coverage` (`vitest run --coverage`)

---

## Summary

| Metric      | Coverage |
|-------------|----------|
| Statements  | 87.06%   |
| Branches    | 90.16%   |
| Functions   | 95.00%   |
| Lines       | 87.06%   |
| Test files  | 9        |
| Total tests | 153      |

---

## Per-file Breakdown

| File | Stmts | Branches | Funcs | Lines | Uncovered Lines |
|------|-------|----------|-------|-------|-----------------|
| `http-utils.ts` | **100%** | **100%** | **100%** | **100%** | — |
| `mcp-client.ts` | **100%** | 91.3% | **100%** | **100%** | 25, 68 |
| `mcp.ts` | 93.33% | 92.3% | **100%** | 93.33% | 107–111 |
| `service-core.ts` | **100%** | 91.22% | **100%** | **100%** | 79, 108–109, 193, 207 |
| `service.ts` | 32.89% | 42.85% | 66.66% | 32.89% | 52–58, 72–119, 127–135 |
| `tg-api.ts` | **100%** | **100%** | **100%** | **100%** | — |
| `tg-utils.ts` | **100%** | **100%** | **100%** | **100%** | — |

---

## What Was Added by the Swarm

The swarm ran 8 parallel sub-tasks and merged multiple PRs into `main`. Starting from zero tests, the following was built:

### Test Files Added

| File | Tests | What is Covered |
|------|-------|-----------------|
| `queue.test.ts` | 11 | Sequential queue FIFO order, re-entrancy guard (`activeRequestId` claimed before `await`), failure flow (slot released, waiters notified with `null`) |
| `http-utils.test.ts` | 13 | `readBody` chunk assembly + error propagation, `sendJson` status/headers/no-op guard |
| `service-core.test.ts` | 29 | `createServiceState` CRUD, `createProcessQueue` success/failure/photo/context paths, `createHttpHandler` all routes (GET /health, POST /request, GET /response/:id, long-poll, timeout, 404) |
| `mcp-client.test.ts` | 16 | `postRequest` success/ECONNREFUSED/non-ok/missing id, `pollResponse` immediate/retry/timeout/network-error, `requestHumanInput` end-to-end |
| `tg-api.test.ts` | 15 | `tgSendMessage`, `tgSendPhoto` (readFile + multipart), `tgGetUpdates` — success, non-ok, fetch-throw, readFile-reject |
| `tg-utils.test.ts` | 16 | `getMimeType` all extensions + case-insensitive + fallback, `formatTelegramText` with/without context |
| `service.test.ts` | 14 | Module startup (env-var checks, server listen, pollLoop launch), HTTP wrapper path, long-poll timeout via mocked handler |
| `integration.test.ts` | 24 | Real TCP socket end-to-end: chunked body, Content-Type headers, concurrent connections, queue sequencing via `deliverAnswer` helper |
| `mcp.test.ts` | 15 | MCP SDK handler registration (`ListTools`, `CallTool`), all tool branches (unknown tool, missing question, valid input, `image_path`, Error/non-Error throws), `main()` transport connect |

### Source Modules Extracted for Testability

The swarm also refactored the codebase to enable coverage (these changes are part of the merged PRs):

| Module | Purpose |
|--------|---------|
| `service-core.ts` | Extracted from `service.ts`: `createServiceState`, `createProcessQueue`, `createHttpHandler` — all pure/DI, no env reads or server startup |
| `mcp-client.ts` | Extracted from `mcp.ts`: `postRequest`, `pollResponse`, `requestHumanInput` — no SDK imports, mockable via `vi.stubGlobal` |
| `http-utils.ts` | `readBody`, `sendJson` |
| `tg-api.ts` | `tgSendMessage`, `tgSendPhoto`, `tgGetUpdates` |
| `tg-utils.ts` | `getMimeType`, `formatTelegramText` |

---

## Remaining Gaps and Why

### `service.ts` — 32.89% statements (HIGH RISK, intentional)

**Uncovered regions:**
- **`tgSend` closure (lines 52–58)**: The concrete Telegram dispatch function that wires the injected `tg-api` functions to the real `CHAT_ID`. Not tested because it requires real env vars and live Telegram calls.
- **`pollLoop` (lines 72–119)**: Infinite `while(true)` daemon that long-polls the Telegram Bot API. All branches within it (chat-id mismatch guard, empty-text guard, no-active-request path, answer routing, error recovery with `setTimeout`) are untested.
- **Server startup (lines 127–135)**: `httpServer.listen` callback (starts `pollLoop`) and `httpServer.on("error")` handler. Both fire only at process startup.

**Why not tested:** `service.ts` loads environment variables at module scope (`process.exit` if missing) and immediately starts an HTTP server and infinite poll loop. This is the thin CLI shell by design — the testable business logic was extracted into `service-core.ts`. Testing `pollLoop` directly would require extracting a `handleUpdate(state, update)` function from it (recommended next step).

**Risk level:** MEDIUM. The logic in `pollLoop` is the highest-risk untested path — it contains the chat-ID guard, the answer-routing logic, and the error-recovery delay. A bug here would silently drop Telegram replies.

### `mcp-client.ts` — Branch 91.3% (lines 25, 68)

**Uncovered:** The `String(err)` branch in two `catch` blocks — triggered only when `fetch` rejects with a non-Error value (e.g., a bare string). In practice, all Node.js network rejections throw `Error` instances, so this branch is unreachable in production.

### `mcp.ts` — Statements 93.33% (lines 107–111)

**Uncovered:** The `process.stderr.write` + `process.exit(1)` block in the `main().catch()` handler. Triggered only if the MCP transport fails to connect at startup. Excluded by `/* v8 ignore */` in some branch iterations; not guarded in the current merged state.

### `service-core.ts` — Branch 91.22% (lines 79, 108–109, 193, 207)

**Uncovered branches:**
- Line 79: `String(err)` for non-Error thrown from `tgSend` (same pattern as `mcp-client.ts`)
- Lines 108–109: `req.url ?? "/"` and `req.method ?? "GET"` fallbacks — Node.js HTTP always populates these
- Line 193: `entry.failReason ?? "send failed"` — fallback string only reachable if `failReason` is undefined when waiter fires (not possible via current code paths)
- Line 207: `String(err)` in the HTTP handler catch block — requires a non-Error thrown from handler logic

All of these are defensive `??`/`instanceof` branches that guard against semantically impossible states in Node.js HTTP or vitest's type system.

---

## Recommended Next Steps (Priority Order)

1. **Extract `handleUpdate(state, update)` from `pollLoop`** — makes the core Telegram reply routing testable without running a real server. Covers the chat-ID guard, answer dispatch, waiter notification, and error logging paths. Expected to raise `service.ts` coverage from 32% → ~70%.

2. **Add `/* v8 ignore start/stop */` to `service.ts` startup block** (lines 127–135) and the env-var exit paths (lines 32–38) — these are intentional side-effect guards, not business logic.

3. **Cover `mcp.ts` lines 107–111** — add a test that calls `main()` with a transport that rejects, verifying the `process.exit(1)` path.

4. **Cover `String(err)` branches** (mcp-client.ts:25, 68; service-core.ts:79, 207) — add tests that mock `fetch` to reject with a non-Error value (`mockRejectedValueOnce("raw string")`).

---

## Key Patterns Discovered

- **[gotcha]** vitest fakes `queueMicrotask` and `setImmediate`; use `Promise.resolve().then()` (V8 microtask queue) for async body emission in fake-timer tests.
- **[gotcha]** `vi.mock("http", ...)` must match the exact import string in the source (not `"node:http"`).
- **[gotcha]** `vi.useFakeTimers()` in `beforeEach` blocks `setTimeout(r, 0)` used in retry loops — use real timers or `vi.useRealTimers()` for those tests.
- **[pattern]** `vi.hoisted()` is required to initialize shared state (e.g., handler maps) before `vi.mock()` factory functions run.
- **[pattern]** Integration tests using real TCP sockets (`http.createServer` + random port) catch chunked-body and header bugs that pure unit tests miss.
- **[workflow]** `gh pr merge --squash --auto` fails when repo auto-merge is disabled; use `gh pr merge --squash` instead.
