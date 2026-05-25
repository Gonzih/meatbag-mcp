# PLAN: Write tests for uncovered business logic

## Task restatement
Add comprehensive unit and integration tests for all core business logic in
`src/service.ts` and `src/mcp.ts`. Zero tests currently exist. Cover all major
code paths, conditional branches, and service interactions.

## Approach: minimal refactor + jest integration

1. Export testable functions from both source files.
2. Guard side-effectful startup code with `if (require.main === module)`.
3. Add a `_state` export object + `_resetState()` to `service.ts` so tests can
   inspect and reset in-memory queue state between cases.
4. Extract the anonymous HTTP callback to a named `httpHandler` export so
   integration tests can spin up isolated servers on random ports.
5. Use `jest` + `ts-jest` for the test runner.
6. Mock `global.fetch` for Telegram API calls in unit tests.
7. Use Node's built-in `http` module (not global `fetch`) as the HTTP client
   inside integration tests — avoids conflicts with Telegram `fetch` mocks.

## Files to touch
- `package.json` — add jest/ts-jest/@types/jest devDeps + `test` script + jest config
- `src/service.ts` — export functions, `_state`, `_resetState`, `httpHandler`; guard startup
- `src/mcp.ts` — export `postRequest`, `pollResponse`, `requestHumanInput`; guard MCP server startup
- `src/__tests__/service.test.ts` — new
- `src/__tests__/mcp.test.ts` — new

## Risks
- `.js` extension imports from `@modelcontextprotocol/sdk` may not resolve in
  ts-jest CJS env → mitigated by mocking the SDK entirely in `mcp.test.ts`
- `void processQueue()` fire-and-forget calls need microtask draining in tests
  → use `await Promise.resolve()` loops
- `processQueue` calls itself recursively on failure → flush event loop with setImmediate
