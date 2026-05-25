# PLAN: Test uncovered utility functions and helpers

## Task Restatement
Identify all utility, helper, and standalone functions in the codebase that lack test coverage.
Extract them into separately-importable modules (minimum necessary restructuring), install a
test framework, and write comprehensive unit tests targeting 95%+ coverage for each utility module.

## Functions to Cover

### From src/service.ts (currently untestable — no exports, module-level side effects)
- `readBody(req)` — HTTP stream body reader
- `sendJson(res, status, data)` — JSON response writer
- MIME type mapping (inline in tgSendPhoto)
- `formatTelegramText(question, context?)` — builds Telegram message text
- `tgSendMessage`, `tgSendPhoto`, `tgGetUpdates` — Telegram API wrappers
- `processQueue()` — FIFO queue dispatcher (core business logic)
- HTTP handler logic: GET /health, POST /request, GET /response/:id

### From src/mcp.ts (currently untestable — module-level main() call)
- `postRequest(serviceUrl, question, image_path?)` — POST to service
- `pollResponse(serviceUrl, requestId, opts?)` — long-poll for answer
- `requestHumanInput(serviceUrl, question, image_path?)` — composite

## Approach

### A: Extract utility modules (chosen)
- `src/http-utils.ts` — readBody, sendJson (no external deps)
- `src/tg-utils.ts` — getMimeType, formatTelegramText (pure)
- `src/tg-api.ts` — tgSendMessage, tgSendPhoto, tgGetUpdates (parameterized, fetch-mockable)
- `src/service-core.ts` — RequestEntry type, ServiceState, createProcessQueue, createHttpHandler
- `src/mcp-client.ts` — postRequest, pollResponse, requestHumanInput
- service.ts and mcp.ts become thin wrappers importing from these modules
- Tests import extracted modules directly

**Pros:** Clean separation, 100% testable, no process.exit or server.listen in test scope
**Cons:** Minor refactor needed to service.ts and mcp.ts (low risk)

### B: Mock module-level side effects with jest.mock
- Mock process.exit, global.fetch, http.createServer, etc. at test time
- Import service.ts and mcp.ts directly
**Cons:** Fragile, hard to reset state between tests, pollLoop runs as side effect

### C: Subprocess integration tests
- Spawn the actual service process, make HTTP requests, kill it
**Cons:** Slow, flaky, no coverage for fine-grained units

**Chosen: A** — cleanest, most maintainable, good isolation

## Files to Touch

New source modules:
- `src/http-utils.ts`
- `src/tg-utils.ts`
- `src/tg-api.ts`
- `src/service-core.ts`
- `src/mcp-client.ts`

Modified:
- `src/service.ts` — import from extracted modules
- `src/mcp.ts` — import from mcp-client.ts
- `package.json` — add jest, ts-jest, @types/jest, test script
- `tsconfig.json` — exclude __tests__ from production build

New config:
- `jest.config.js`
- `tsconfig.test.json` — extends tsconfig, includes __tests__

New tests:
- `src/__tests__/http-utils.test.ts`
- `src/__tests__/tg-utils.test.ts`
- `src/__tests__/tg-api.test.ts`
- `src/__tests__/service-core.test.ts`
- `src/__tests__/mcp-client.test.ts`

## Risks
- service.ts refactor must preserve identical runtime behavior
- processQueue re-entrancy guard must still work (set activeRequestId before await)
- Long-poll timeout tests need configurable timeout or fake timers — use configurable param
