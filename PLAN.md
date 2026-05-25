# PLAN: write tests for all API endpoints and controllers

## Task Restatement
Modify `service.ts` so that only one Telegram message is visible (unanswered) at a time.
When a second `POST /request` arrives while the first is still awaiting a reply, defer
sending the second Telegram message until the first is answered. Queue drains FIFO.
`mcp.ts` and the HTTP API surface must not change.

## Current Behavior
- `POST /request` sends Telegram message immediately and pushes to `pendingQueue`
- Multiple requests → multiple visible Telegram questions simultaneously
- User has no idea which question their reply addresses

## Required Behavior
- Only the "active" request is visible in Telegram at any time
- New requests enqueue in `sendQueue`; Telegram message is deferred until active slot is free
- On Telegram reply → mark active answered, pop next from `sendQueue`, send it

## Approach

### A: Single active slot + send queue (chosen)
- `sendQueue: string[]` — requests waiting to be sent to Telegram
- `activeRequestId: string | null` — the one request currently shown in Telegram
- `processQueue()` — idempotent dispatcher: sends next from `sendQueue` if slot is free
- Called on: new request arrives, Telegram reply received, Telegram send error

**Pros:** minimal state, correct FIFO, no changes to HTTP surface
**Cons:** none significant

### B: Re-use pendingQueue with a "sent" flag per entry
- Add `sent: boolean` to RequestEntry; only send when previous entry.sent becomes answered
- Messier: requires scanning queue rather than O(1) slot check

**Chosen: A** — cleaner, minimal diff

## Files to Touch
- `src/service.ts` — only file that changes

## Key Design Decisions
- `waiters` type: `(answer: string | null) => void` — `null` signals Telegram send failure
- `failReason?: string` on RequestEntry — so `GET /response/:id` can return a 502
- `processQueue()` is always called with `void` (fire-and-forget); it guards re-entrancy
  via `activeRequestId !== null` check
- `GET /health` updated to show `{ queued, active }` instead of `{ pending }`
- Remove old `pendingQueue` completely (replaced by `sendQueue` + `activeRequestId`)

## Risks
- `processQueue` called concurrently: safe because it returns early if `activeRequestId !== null`
  and `sendQueue.shift()` is synchronous (no race before await)
- Telegram send takes time: `activeRequestId` is set before the await, so concurrent
  `processQueue` calls return early correctly
