# PLAN: central service + thin MCP clients

## Task Restatement
Split the monolithic `src/index.ts` (one Telegram bot per MCP client) into:
1. `meatbag-service` — standalone HTTP daemon on :7702, owns the single Telegram bot
2. `meatbag-mcp` — thin MCP client, no Telegram, just talks to localhost:7702

Both binaries ship in the same `@gonzih/meatbag-mcp` package.

## Approach Options

### A: HTTP long-poll service (chosen)
- Service holds `GET /response/:id` connections open for ≤30s until Telegram reply arrives
- MCP client retries the GET if it returns empty (no answer yet)
- No external deps beyond existing `@modelcontextprotocol/sdk`
- **Pros:** clean separation, no polling on client side, fast response delivery
- **Cons:** requires persistent service process

### B: Short-poll only
- Service immediately returns `{ pending: true }` if no answer; client polls every 2s
- Simpler server code, but generates more HTTP requests for long waits

### C: Server-Sent Events
- Service streams updates; client listens until answer arrives
- More complex to implement correctly with Node.js http module

**Chosen: A** — long-poll is the cleanest balance of simplicity and efficiency.

## Files to Create/Modify
- `src/service.ts` — new: HTTP server + Telegram bot
- `src/mcp.ts` — new: thin MCP client
- `src/index.ts` — delete (replaced by above two)
- `package.json` — two bin entries, updated description, bump to 1.1.0
- `PLAN.md` / `TODO.md` — this file

## Key Design Decisions
- `GET /response/:id` long-polls up to 30s; returns `{}` if timed out (client retries)
- FIFO queue in service: oldest pending request gets next Telegram reply
- `image_path` → service reads file, sends `sendPhoto` via multipart form
- `MEATBAG_SERVICE_URL` env var (default `http://localhost:7702`) for override
- Service polls Telegram continuously (not lazy) since it's a persistent daemon
- Cleanup: answered requests stay in Map (fine for in-memory, service restarts clean)

## Risks & Unknowns
- `FormData` + `Blob` for image upload: Node 18 supports both globally
- TypeScript strict mode with Node http module types — need `@types/node`
- Existing `@types/node` devDep covers the http module
- npm publish token must be available
