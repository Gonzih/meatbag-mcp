# Coverage Gap Analysis — meatbag-mcp

Generated: 2026-05-25  
Test runner: Vitest 3.2.2 + @vitest/coverage-v8  
Command: `npm run coverage` (105 tests, 5 suites, all pass)

---

## Summary

| File | Statements | Branches | Functions | Lines |
|------|-----------|----------|-----------|-------|
| `src/mcp.ts` | **94.81%** | **88.89%** | **100%** | **94.81%** |
| `src/service-core.ts` | **100%** | **92.30%** | **100%** | **100%** |
| `src/service.ts` | **42.24%** | **37.50%** | **50%** | **42.24%** |
| **Overall** | **81.36%** | **87.15%** | **86.67%** | **81.36%** |

### Test suites
| File | Tests | Purpose |
|---|---|---|
| `src/__tests__/http-utils.test.ts` | 13 | `readBody`, `sendJson` from service-core |
| `src/__tests__/queue.test.ts` | 11 | Request store + queue state machine |
| `src/__tests__/service-core.test.ts` | 52 | Full HTTP endpoints via real test server |
| `src/__tests__/service.test.ts` | 14 | service.ts module: startup, tgSend*, pollLoop wrapper |
| `src/__tests__/mcp.test.ts` | 15 | MCP client (postRequest, pollResponse, tool handlers) |

---

## `src/service-core.ts` — Gap Details (100% statements, 92.3% branches)

`service-core.ts` achieves full statement coverage thanks to the comprehensive
`service-core.test.ts` suite. The remaining branch gaps are:

### Uncovered branches: lines 118, 148–149, 234, 248

**Line 118** — `processQueue`: `if (!entry)` guard (entry removed from Map after
enqueue — impossible under normal operation; defensive guard).

**Lines 148–149** — `processQueue` catch block: the `void processQueue(state, tg)`
recursive call after failure. This line executes but the branch where `sendQueue`
is non-empty at that point is not exercised (the error tests drain the queue).

**Line 234** — `GET /response/:id`: `if (answer === null)` inside the long-poll
waiter callback. This requires a Telegram failure *while* a waiter is actively
long-polling. The test suite covers the failure path via `failReason` (fast-return
before a waiter is registered) but not the concurrent-failure scenario.

**Line 248** — `GET /response/:id`: `sendJson(res, 404, ...)` for `!entry` path
inside the long-poll continuation. Requires an entry to be garbage-collected while
a GET /response/:id is long-polling.

**Risk:** Low for all four — these are edge-case guards for race conditions or corrupt
state that don't arise in production without bugs elsewhere.

**Suggested fix for 234:** Register a waiter via GET /response/:id long-poll, then
call processQueue directly with a failing sender, verify the null branch fires.

---

## `src/mcp.ts` — Gap Details (94.81% statements)

### Uncovered lines: 89–90, 182–186

**Lines 89–90** — `pollResponse` deadline exceeded
```typescript
throw new Error("Timed out waiting for human response (5 minutes)");
```
**Why uncovered:** Requires the 5-minute `MAX_WAIT_MS` deadline to elapse while every
poll returns an empty body. Without mocking `Date.now()` across a module boundary
this path cannot be reached in a short-lived test.

**Risk:** Medium. If the service becomes permanently unresponsive, MCP clients hang
forever rather than surfacing a clean error to the LLM agent.

**Suggested fix:** Spy on `Date.now` to return a value beyond the deadline after the
first call, then verify the next `while` iteration exits and throws.

---

**Lines 182–186** — `main()` fatal error catch handler
```typescript
main().catch((err) => {
  process.stderr.write(`[meatbag-mcp] Fatal: ...`);
  process.exit(1);
});
```
**Why uncovered:** `server.connect()` is mocked to succeed; the catch branch never fires.

**Risk:** Low. Any unhandled startup error silently swallows the stack trace.

**Suggested fix:** Mock `StdioServerTransport` to throw, spy on `process.exit`.

---

## `src/service.ts` — Gap Details (42.24% statements)

`service.ts` is a thin shell: env-var checks, concrete Telegram implementations,
server startup, and the `pollLoop`. Most business logic lives in `service-core.ts`
(100% covered). The low statement coverage of `service.ts` reflects functions that
cannot safely run in tests (infinite polling loop, Telegram API helpers, server startup).

### What IS covered in service.ts (tests in service.test.ts)
- Env-var validation path (BOT_TOKEN, CHAT_ID present → no exit)
- `createServer` call — wrapper captured
- GET /health, POST /request (validation + success), GET /response/:id (404, 502, long-poll timeout)
- `tgSendMessage` happy path (via processQueue, covered by sendMessage failure test)
- `tgSendPhoto` happy path (via processQueue photo test)
- `tgSendMessage` error path → catch → `failReason` set
- Unknown routes → 404
- Body stream error → 500

### Uncovered lines in service.ts

**Lines 33–40** — Startup exit for missing env vars
```typescript
if (!BOT_TOKEN) { process.exit(1); }
if (!CHAT_ID)   { process.exit(1); }
```
**Why:** Env vars set before module import; guards never fire.
**Risk:** Low (observable at startup; one-line guards).
**Fix:** `vi.isolateModules()` + delete env var + spy on `process.exit`.

---

**Lines 79–91** — `tgGetUpdates` function (entire function)
```typescript
async function tgGetUpdates(offset, timeoutSecs): Promise<TgUpdate[]> { ... }
```
**Why:** Only called from `pollLoop`. The `listen` callback mock does not invoke the
callback, so `pollLoop` is never started.
**Risk:** High. Bugs in offset management, JSON parsing, or error handling in
`getUpdates` are completely invisible to the test suite.
**Fix:** Extract `tgGetUpdates` to `service-core.ts` (or a shared module) and add
direct unit tests for it — success path, `!res.ok` path, and the `.result ?? []`
fallback.

---

**Lines 108–155** — `pollLoop` function (entire function)
```typescript
async function pollLoop(): Promise<void> { while (true) { ... } }
```
**Why:** `pollLoop()` is called inside the `listen` callback which is mocked to not
fire.

Key untested branches inside pollLoop:
- Normal Telegram reply routing → `state.activeRequestId` cleared, waiters notified
- Chat ID mismatch guard
- Empty text guard
- No active request guard
- Entry-not-found guard after clearing `activeRequestId`
- Non-abort polling error → 1-second retry delay
- AbortError/TimeoutError suppression

**Risk:** Very high. This is the core business logic: routing Telegram replies to
waiting HTTP clients. Every failure mode here is completely untested at the
integration level.

**Fix (priority):**
1. Extract a `handleUpdate(state, tg, update)` function from `pollLoop` body
2. Unit-test `handleUpdate` with synthetic `TgUpdate` objects
3. Test: normal reply, chat ID mismatch, empty text, no active request, entry gone,
   multiple queued requests drain correctly after each reply

---

**Lines 167–174** — Server startup callback and error handler
```typescript
httpServer.listen(PORT, "127.0.0.1", () => {
  process.stderr.write(...);
  void pollLoop();           // line 168
});
httpServer.on("error", (err) => {
  process.stderr.write(...);
  process.exit(1);           // line 173
});
```
**Why:** `listen` mock does not invoke callback; `on("error")` is a no-op stub.
**Risk:** Low (boilerplate; `process.exit` is hard to test cleanly).

---

## Prioritised Remediation Roadmap

### Priority 1 — Core business logic (very high risk, quick wins)

1. **Extract `handleUpdate(state, tg, update: TgUpdate)` from `pollLoop`** and add to
   `service-core.ts`. Unit-test all branches:
   - Normal reply → answer stored, waiters fired, next queue item sent
   - Chat ID mismatch → ignored
   - Empty text → ignored
   - No active request → logged and skipped
   - Entry disappeared after clearing activeRequestId → processQueue called anyway

2. **Test concurrent Telegram failure** (service-core.ts line 234): start a
   GET /response/:id long-poll, then trigger processQueue failure, verify the
   `null` waiter branch fires and the client gets a 502.

3. **Test `tgGetUpdates`** (service.ts lines 79–91): extract to service-core or
   mock at the fetch level and add success + error unit tests.

### Priority 2 — Timeout and startup (medium risk)

4. **Test `pollResponse` deadline exceeded** (mcp.ts:89–90): spy on `Date.now` to
   return a value beyond `MAX_WAIT_MS`, verify `Timed out` error is thrown.

5. **Test missing env vars** (service.ts:33–40): `vi.isolateModules()` + `process.exit`
   spy to verify correct error messages.

### Priority 3 — Low-risk boilerplate (low risk)

6. Server error handler (`process.exit` on server `"error"` event)
7. `main().catch` handler in mcp.ts

---

## Coverage Status: What the test suite verifies end-to-end

- All HTTP input validation (400s for bad JSON, missing/empty question)
- Request body stream error → 500 handler  
- `processQueue` text-message dispatch path (sends to Telegram, sets activeRequestId)
- `processQueue` failure path (Telegram error → failReason → 502 on next GET)
- `processQueue` photo path (image_path → sendPhoto endpoint called)
- `GET /response/:id` — 404 for unknown ID
- `GET /response/:id` — 502 fast-path when failReason already set
- `GET /response/:id` — long-poll 30s timeout → empty `{}` body
- `sendJson` guard for `res.destroyed`
- All MCP tool-list and tool-call handler branches (except deadline exceeded)
- `postRequest`: success, service-down, non-ok response, missing request_id
- `pollResponse`: success, retry on empty, non-ok response, fetch throw
- Sequential queue behavior end-to-end (service-core.test.ts)
- Multiple concurrent long-pollers all receive the same answer (service-core.test.ts)
