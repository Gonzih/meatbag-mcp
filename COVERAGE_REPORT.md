# Coverage Gap Analysis — meatbag-mcp

Generated: 2026-05-25  
Test runner: Jest 29 + ts-jest (V8 coverage provider)  
Command: `npm test` (30 tests, 2 suites, all pass)

---

## Summary

| File | Statements | Branches | Functions | Lines |
|------|-----------|----------|-----------|-------|
| `src/mcp.ts` | **96.23%** (154/160) | **88.89%** (32/36) | **100%** (5/5) | **96.23%** |
| `src/service.ts` | **76.08%** (305/401) | **75.86%** (44/58) | **66.67%** (8/12) | **76.08%** |
| **Overall** | **82.85%** (459/554) | **80.85%** (76/94) | **76.92%** (10/13) | **82.85%** |

---

## `src/mcp.ts` — Gap Details

### Uncovered lines: 88–90, 182–185

#### Lines 88–90 — `pollResponse` deadline exceeded
```typescript
// line 89
throw new Error("Timed out waiting for human response (5 minutes)");
```
**Why uncovered:** Requires the 5-minute `MAX_WAIT_MS` deadline to elapse while every
poll returns an empty response. Without mocking `Date.now()` at the module level this
path cannot be reached in a short-lived test.

**Risk:** Medium. If the service becomes permanently unresponsive, MCP clients would
hang forever rather than surfacing a clean error.

**Suggested fix:** Extract `MAX_WAIT_MS` to an injectable config, or spy on `Date.now`
and `setTimeout` to fast-forward time in an isolated module test.

---

#### Lines 182–185 — `main()` fatal error handler
```typescript
main().catch((err) => {
  process.stderr.write(`[meatbag-mcp] Fatal: ...`);
  process.exit(1);
});
```
**Why uncovered:** `server.connect()` is mocked to succeed; the catch branch never fires.

**Risk:** Low. Any unhandled error in main() silently swallows the stack trace without
this path being tested.

**Suggested fix:** In an isolated module test, mock `StdioServerTransport` to throw and
spy on `process.exit`.

---

## `src/service.ts` — Gap Details

### Uncovered lines: 29–31, 33–35 — Missing env-var exit paths

```typescript
if (!BOT_TOKEN) {
  process.stderr.write("[meatbag-service] MEATBAG_BOT_TOKEN env var is required\n");
  process.exit(1);
}
```
**Why uncovered:** Env vars are set before the module is required; these guards never
fire during the test run.

**Risk:** Low — the guard is a one-liner exit. Real-world failure is easy to observe.

**Suggested fix:** Use `jest.isolateModules()` with `process.exit` spied-on and env vars
temporarily deleted, then re-set after the isolated require.

---

### Uncovered lines: 84–85 — `tgSendMessage` happy-path `!res.ok` guard

```typescript
if (!res.ok) {
  throw new Error(`sendMessage failed: ${res.status} ${await res.text()}`);
}
```
**Note:** The *throw path* (lines 62–63 / same guard in tgSendMessage) **is** covered
by the processQueue failure test. The uncovered lines 84–85 refer to the analogous
guard inside **`tgGetUpdates`** (lines 88–100), which is part of the polling loop.

---

### Uncovered lines: 88–100 — `tgGetUpdates` function (entire function)

```typescript
async function tgGetUpdates(offset: number, timeoutSecs: number): Promise<TgUpdate[]> {
  const res = await fetch(`${TG_API}/getUpdates`, { ... });
  if (!res.ok) { throw new Error(...); }
  const data = ... as { ok: boolean; result: TgUpdate[] };
  return data.result ?? [];
}
```
**Why uncovered:** `tgGetUpdates` is only called from `pollLoop`. The HTTP server's
`listen` callback (which starts `pollLoop`) is mocked to not invoke its callback, so
the polling loop never runs.

**Risk:** High. This is the only path through which Telegram replies are received.
Any bug in offset management, JSON parsing, or error recovery goes completely untested.

**Suggested fix:** Export `tgGetUpdates` (or a thin wrapper) and test it directly
with mocked `fetch`, or start `pollLoop` in a controlled test with fake timers and
a mock that immediately returns updates.

---

### Uncovered lines: 145–148 — `processQueue`: entry-not-found edge case

```typescript
if (!entry) {
  void processQueue(); // try next
  return;
}
```
**Why uncovered:** Requires a request ID to be in `sendQueue` with no corresponding
entry in the `requests` Map — an impossible state under normal operation.

**Risk:** Negligible (defensive guard for corrupt state).

---

### Uncovered lines: 161, 185–232 — `pollLoop` (entire function)

```typescript
async function pollLoop(): Promise<void> {
  process.stderr.write("[meatbag-service] Telegram polling started\n");
  while (true) { ... }
}
```
Line 161 is the `image_path` branch inside `processQueue` (partially covered — the
`tgSendPhoto` call is reached but the surrounding branch condition varies).

Lines 185–232 cover the entire `pollLoop` body including:
- Normal Telegram reply routing → `activeRequestId` cleared, waiters notified
- Chat ID mismatch guard
- Empty message guard  
- `activeRequestId === null` guard (no active request)
- Entry-not-found guard after clearing activeRequestId
- Error handling with retry delay
- AbortError / TimeoutError suppression

**Risk:** Very high. This is the core business logic: routing Telegram replies to
waiting HTTP clients. None of these paths are exercised by unit tests.

**Suggested fix:**
1. Extract `pollLoop` body into a `handleUpdate(update: TgUpdate)` function
2. Unit-test `handleUpdate` with synthetic update objects
3. Test the error-recovery path (non-abort errors, abort errors, empty update list)

---

### Uncovered lines: 317–319, 337–343 — `GET /response/:id` long-poll success paths

```typescript
// line 317-319: already-answered fast path
if (entry.answer !== undefined) {
  sendJson(res, 200, { answer: entry.answer });
  return;
}

// lines 337-343: waiter callback (answer arrives while polling)
const handler = (answer: string | null) => {
  clearTimeout(timer);
  if (answer === null) {
    sendJson(res, 502, { error: `Telegram error: ...` });
  } else {
    sendJson(res, 200, { answer });
  }
  resolve();
};
```
**Why uncovered:** Both paths require `entry.answer` to be set, which only happens
inside `pollLoop` when a Telegram reply is received. Since `pollLoop` is never started
in tests, `answer` is never populated.

The `answer === null` branch of the waiter callback (502 when Telegram fails *while*
a GET /response is long-polling) is similarly unreachable.

**Risk:** High. The primary success path — human answers → client gets the answer —
is completely untested.

**Suggested fix:** After extracting `handleUpdate`, call it in tests to simulate a
Telegram reply arriving while a waiter is registered. Test both the happy path
(string answer) and the failure path (null → 502).

---

### Uncovered lines: 361–362 — `httpServer.listen` callback and `pollLoop` start

```typescript
httpServer.listen(PORT, "127.0.0.1", () => {
  process.stderr.write(`[meatbag-service] Listening on http://127.0.0.1:${PORT}\n`);
  void pollLoop(); // ← line 362
});
```
**Why uncovered:** `listen` is mocked to not invoke its callback.

**Risk:** Low for the callback itself; high coverage impact is already captured under
the `pollLoop` gap above.

---

### Uncovered lines: 366–367 — HTTP server error handler

```typescript
httpServer.on("error", (err) => {
  process.stderr.write(`[meatbag-service] HTTP server error: ${err.message}\n`);
  process.exit(1);
});
```
**Why uncovered:** Requires `httpServer` to emit an `"error"` event; the mock server
object's `on` is a jest stub that doesn't emit.

**Risk:** Low (error handler is boilerplate; process.exit is hard to test anyway).

---

## Branch-Level Gaps

| Location | Condition | Missing branch |
|---|---|---|
| `service.ts:155` | `if (entry.context)` in processQueue | context present (tested via POST with context field) |
| `service.ts:157` | `if (entry.image_path)` | both branches covered |
| `service.ts:195–196` | `if (!msg)` / chat ID check | both guards — inside pollLoop (not started) |
| `service.ts:200` | `if (activeRequestId === null)` | both — inside pollLoop |
| `service.ts:226` | AbortError/TimeoutError filter | both — inside pollLoop error handler |
| `mcp.ts:88` | `while (Date.now() < deadline)` | exit when deadline exceeded |
| `mcp.ts:135` | `request.params.name !== "request_human_input"` | covered (unknown tool test) |

---

## Prioritised Remediation Roadmap

### Priority 1 — Core business logic (high risk)
1. Extract `handleUpdate(update: TgUpdate)` from `pollLoop` and add unit tests  
   covering: normal reply, chat ID mismatch, empty text, no active request, entry gone.
2. Add a `GET /response/:id` test that populates `entry.answer` via `handleUpdate`
   and verifies the fast-path 200 response.
3. Test the long-poll waiter callback: register a waiter, then call `handleUpdate` to
   trigger it — verify both the success (200) and failure (502) branches.

### Priority 2 — Error recovery (medium risk)
4. Test `tgGetUpdates` in isolation with mocked fetch (ok path + !ok path).
5. Test `pollLoop` error recovery: non-abort error → 1s delay → continues.
6. Test `pollResponse` deadline exceeded in mcp.ts via `Date.now` mock.

### Priority 3 — Startup validation (low risk)
7. Add isolated-module tests for missing `MEATBAG_BOT_TOKEN` / `MEATBAG_CHAT_ID`
   with `process.exit` spied on.
8. Add `main().catch` test in mcp.ts by mocking `server.connect` to reject.

---

## What Current Tests Do Cover

- All HTTP input validation (400s for bad JSON, missing/empty question)
- Request body stream error → 500 handler
- `processQueue` normal dispatch: sends to Telegram via `tgSendMessage`
- `processQueue` error path: Telegram failure → `failReason` set → 502 on next GET
- `processQueue` image path: `tgSendPhoto` called when `image_path` is present
- `GET /response/:id` — 404 for unknown ID
- `GET /response/:id` — 502 fast-path when `failReason` is already set
- `GET /response/:id` — long-poll timeout (30s timer fires → empty `{}` body)
- `sendJson` guard for `res.destroyed`
- All MCP tool-list and tool-call handler branches except the deadline-exceeded path
- `postRequest`: success, service-down, non-ok response, missing request_id
- `pollResponse`: success, retry on empty, non-ok response, fetch throw
