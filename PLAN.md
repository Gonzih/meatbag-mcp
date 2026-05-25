# PLAN: Write tests for error handling and edge cases

## Task Restatement
Add a test suite covering all uncovered error handling, exception paths, boundary
conditions, and edge cases across both `service.ts` (service-core logic) and `mcp.ts`
(client logic). Currently zero tests exist.

## Challenge
Both source files have module-level side effects (env-var checks + `process.exit`,
`httpServer.listen`, MCP server startup) making them un-importable in tests. Functions
are also un-exported.

## Approaches

### A: Integration tests only (hit real HTTP server)
- Spin up ServiceCore's HTTP server on a random port per test
- Pros: tests real HTTP flow
- Cons: can't isolate individual functions; Telegram calls still need mocking; pollLoop
  is unkillable; startup side-effects still block

### B: vi.mock the `http` module + set env vars before import (chosen not)
- Pros: no file changes
- Cons: extremely fragile, order-sensitive; doesn't test function internals cleanly

### C: Extract testable logic into separate core modules (CHOSEN)
- Create `src/service-core.ts` — a `ServiceCore` class with all logic, no side effects,
  fully exported
- Create `src/mcp-core.ts` — `postRequest` + `pollResponse` as exported functions
- Slim down `service.ts` / `mcp.ts` to thin entry-point wrappers
- Write tests against the core modules with vitest + vi.mock

**Why C:** Clean isolation, no import-time side effects in core modules, full control of
state per test, easy fetch mocking with `vi.stubGlobal`.

## Files to Touch
- `src/service-core.ts` — NEW: ServiceCore class + readBody/sendJson utilities
- `src/mcp-core.ts` — NEW: postRequest, pollResponse
- `src/service.ts` — thin wrapper, delegates to ServiceCore
- `src/mcp.ts` — thin wrapper, imports from mcp-core
- `src/__tests__/service-core.test.ts` — NEW: ~40 tests
- `src/__tests__/mcp-core.test.ts` — NEW: ~10 tests
- `vitest.config.ts` — NEW: vitest config
- `package.json` — add test script + vitest devDependency
- `tsconfig.json` — exclude test files from production build

## Risks
- `processQueue` is re-entrant (calls `void processQueue()` recursively): tests must
  await full microtask queue with `await Promise.resolve()` to observe side effects
- Long-poll setTimeout (30s): use `vi.useFakeTimers()` in those tests
- `fs/promises` readFile mock must match module name exactly (`"fs/promises"`)
