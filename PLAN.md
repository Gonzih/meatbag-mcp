# PLAN: tests for service data-access and HTTP layer

## Task Restatement
Write tests for the in-memory data-access layer (request store, queue state),
HTTP API endpoints, queue dispatcher, and all error scenarios in meatbag-service.
No database or ORM exists — the "data layer" is a Map + array in service.ts.

## Problem: service.ts is not testable as-is
`service.ts` reads env vars at module load (exits if missing), starts an HTTP server,
and starts `pollLoop()` — all as top-level side effects. Tests cannot `import` it.

## Approaches

### A: Extract core logic to service-core.ts (chosen)
- Move all pure business logic into `src/service-core.ts` (state factory, queue
  dispatcher, HTTP handler factory) with dependency injection for Telegram sender
- `src/service.ts` becomes a thin shell: env checks + concrete Telegram impls +
  server startup + pollLoop
- Tests import from `service-core.ts` — no side effects, full control

**Pros:** clean separation, testable without mocks of globals, no child-process overhead
**Cons:** moderate refactor (~90 line split)

### B: Integration tests via child process
- Spawn `service.ts` as a child process with fake env vars; intercept Telegram
  calls by pointing BOT_TOKEN at a local mock HTTP server
**Pros:** tests real binary
**Cons:** extremely complex, slow, fragile — overkill for this codebase

### C: jest with module mocking
- Mock `process.env` before import; mock `process.exit`; use jest module isolation
**Pros:** zero refactoring
**Cons:** adds heavy jest dependency; still requires mocking process.exit and createServer

**Chosen: A** — minimal new deps (none), clear separation, straightforward tests

## Files to touch
- `src/service-core.ts` (new) — all business logic
- `src/service.ts` (modify) — import from service-core, keep startup only
- `src/service.test.ts` (new) — tests using node:test + node:assert/strict
- `package.json` (modify) — add "test" script

## Test plan
### createServiceState
- empty state on init; independent instances

### Request store (CRUD)
- create, read, update, delete entries
- missing-entry returns undefined
- multiple independent entries
- optional fields (image_path, context)
- waiter callbacks stored and called correctly (string and null)

### Send queue operations
- FIFO order of enqueue/dequeue
- activeRequestId tracking

### processQueue
- no-op when active slot occupied
- no-op when queue empty
- sends text message, sets activeRequestId, consumes queue
- context prefix in message text
- routes to sendPhoto when image_path set
- on Telegram failure: releases slot, sets failReason, fires null to waiters, tries next
- skips missing entries and processes next

### HTTP GET /health
- idle state: queued=0, active=null
- non-empty queue: correct count
- active request: shows ID

### HTTP POST /request
- valid request: 200, UUID request_id, stored in state
- stores image_path, context fields
- invalid JSON → 400
- missing question → 400
- empty question → 400
- non-string question → 400
- enqueues to sendQueue
- second request stays queued behind active first

### HTTP GET /response/:id
- unknown ID → 404
- already answered → 200 with answer
- already failed → 502 with error
- long-polls: waiter receives string → 200
- long-polls: waiter receives null → 502
- long-poll timeout → 200 with {}
- waiter removed from entry after timeout
- multiple concurrent long-pollers all receive answer

### HTTP routing
- unknown route → 404
- wrong method for /request (GET) → 404
- nested /response/foo/bar → 404

### Sequential queue behavior
- first request sent immediately, second queued
- answering active request triggers next queued send

## Risks
- `processQueue` re-entrancy: safe because it returns early on non-null activeRequestId
- Timing in async tests: use small delays (10-50ms) where needed
- Long-poll timeout tests: use longPollTimeoutMs=50 option to keep tests fast
