# PLAN: meetbag-mcp

## Task Restatement
Build a Node.js + TypeScript MCP server (`@gonzih/meetbag-mcp`) that exposes a `request_human_input` tool. When called, it sends a Telegram message to the operator and waits for their reply, then returns the answer. Publish to npm.

## Approaches

### Approach A: Simple queue-based (chosen)
- Single pending-request queue (FIFO)
- Telegram bot in polling mode
- Next incoming Telegram message resolves the oldest pending request
- Simple, no per-UUID tracking, minimal complexity
- Trade-off: if two requests overlap, second queues behind first; acceptable for v1

### Approach B: UUID-based correlation
- Each request tagged with UUID in Telegram message
- User must reply with UUID prefix or use reply-to-message
- More complex, better for concurrent usage
- Trade-off: worse UX (user must copy UUID or use reply feature)

### Approach C: Webhook-based Telegram
- Use ngrok/webhook instead of polling
- More production-ready for high volume
- Trade-off: requires public URL, much more complex setup

## Chosen Approach: A (Simple queue)
Simple, matches spec "oldest pending request gets the next reply", minimal dependencies.

## Files to Create
- `package.json` — npm metadata, scripts, bin entry
- `tsconfig.json` — TypeScript config targeting Node 18+
- `src/index.ts` — main entry: MCP server + Telegram bot + request_human_input tool
- `.gitignore` — node_modules, dist

## Risks & Unknowns
- Telegram polling may conflict with MCP stdio transport — both need event loops; should be fine as Node handles multiple async listeners
- `node-telegram-bot-api` polling mode and unhandled promise rejections — need careful error handling
- npm publish requires login (`npm whoami`) — should already be logged in or need `NPM_TOKEN`
- MCP SDK version — need latest `@modelcontextprotocol/sdk`
