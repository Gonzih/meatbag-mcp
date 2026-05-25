# PLAN: Coverage Audit & Gap Analysis

## Task Restatement
Audit the entire codebase, set up a test framework with coverage instrumentation,
write a representative test suite for both `src/service.ts` and `src/mcp.ts`,
run coverage analysis, and produce a structured coverage gap analysis document.

## Codebase Summary (2 source files, no existing tests)
- `src/service.ts` (369 LOC) — HTTP daemon + Telegram bot polling, sequential queue
- `src/mcp.ts` (186 LOC) — Thin MCP client delegating to service

Neither file exports anything; both run top-level side-effects on import.

## Approach Comparison

### A: Integration tests (spawn real server) [rejected]
Start actual HTTP server in a child process, hit it with real HTTP calls.
Pros: tests real behaviour. Cons: requires real Telegram env vars, slow, flaky.

### B: Module-level mock injection (chosen)
- Mock `node:http` `createServer` to capture the request-handler closure
- Mock `fetch` globally for Telegram API calls
- Mock `@modelcontextprotocol/sdk` to avoid stdio side-effects
- Exercise handler directly with synthetic IncomingMessage / ServerResponse stubs
Pros: fast, hermetic, gets real branch coverage numbers. Cons: slightly indirect.

### C: Static analysis only (no runtime coverage)
Enumerate uncovered paths by reading the source. Produces no numbers.
Rejected — task asks to "run coverage analysis tools."

**Chosen: B** with ts-jest v29 + `--coverage` (V8 provider).

## Files to touch
- `package.json` — add jest + ts-jest dev deps, jest config, test script
- `src/__tests__/service.test.ts` — service HTTP handler & queue unit tests
- `src/__tests__/mcp.test.ts`    — MCP client function tests
- `COVERAGE_REPORT.md`           — structured gap analysis output

## Risks & Unknowns
- `pollLoop` runs an infinite `while(true)` — covered by not triggering it
  (listen callback mock won't call the callback)
- mcp.ts `main()` calls `server.connect()` — mocked at SDK level
- Environment-dependent startup (`process.exit`) — env vars set before require
- ts-jest needs tsconfig path awareness — resolved by `tsconfig` in jest config
