import { IncomingMessage, ServerResponse } from "http";
import { randomUUID } from "crypto";
import { readBody, sendJson } from "./http-utils";
import { formatTelegramText } from "./tg-utils";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RequestEntry {
  id: string;
  question: string;
  image_path?: string;
  context?: string;
  answer?: string;
  /** Set if the Telegram send failed — waiters receive null */
  failReason?: string;
  /** Callbacks waiting on GET /response/:id. null answer signals failure. */
  waiters: Array<(answer: string | null) => void>;
}

/**
 * Injectable Telegram send function — receives the entry and the formatted text.
 * Throw to signal a send failure.
 */
export type TgSendFn = (entry: RequestEntry, tgText: string) => Promise<void>;

export interface ServiceState {
  readonly requests: Map<string, RequestEntry>;
  readonly sendQueue: string[];
  activeRequestId: string | null;
}

// ── Factory helpers ───────────────────────────────────────────────────────────

/** Returns a fresh, empty service state. */
export function createServiceState(): ServiceState {
  return {
    requests: new Map(),
    sendQueue: [],
    activeRequestId: null,
  };
}

/**
 * Returns a `processQueue` function bound to the given state, TG sender, and logger.
 *
 * processQueue is idempotent: safe to call concurrently.
 * It claims `state.activeRequestId` **before** the first `await` to prevent
 * multiple concurrent callers from sending the same request.
 */
export function createProcessQueue(
  state: ServiceState,
  tgSend: TgSendFn,
  log: (msg: string) => void
): () => Promise<void> {
  const processQueue = async (): Promise<void> => {
    // Another request is already active — wait for its reply before sending next
    if (state.activeRequestId !== null) return;
    if (state.sendQueue.length === 0) return;

    const id = state.sendQueue.shift()!;
    const entry = state.requests.get(id);
    if (!entry) {
      // Entry was removed (shouldn't happen normally) — try next
      void processQueue();
      return;
    }

    // Claim the active slot before any await to prevent concurrent sends
    state.activeRequestId = id;

    const tgText = formatTelegramText(entry.question, entry.context);

    try {
      await tgSend(entry, tgText);
      log(`Sent to Telegram: ${id}`);
    } catch (tgErr) {
      // Send failed — release the active slot and notify waiters of the error
      state.activeRequestId = null;
      const msg = tgErr instanceof Error ? tgErr.message : String(tgErr);
      log(`Telegram send failed for ${id}: ${msg}`);
      entry.failReason = msg;
      for (const waiter of entry.waiters) waiter(null);
      entry.waiters = [];
      // Try to send the next queued request
      void processQueue();
    }
  };
  return processQueue;
}

/**
 * Returns an async HTTP handler function (compatible with http.createServer).
 *
 * @param state         Shared service state
 * @param processQueue  Queue dispatcher (result of createProcessQueue)
 * @param log           Logger function
 * @param opts.longPollTimeoutMs  How long GET /response/:id holds the connection (default 30 000)
 */
export function createHttpHandler(
  state: ServiceState,
  processQueue: () => Promise<void>,
  log: (msg: string) => void,
  opts: { longPollTimeoutMs?: number } = {}
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const longPollTimeoutMs = opts.longPollTimeoutMs ?? 30_000;

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    try {
      // GET /health
      if (method === "GET" && url === "/health") {
        sendJson(res, 200, {
          status: "ok",
          queued: state.sendQueue.length,
          active: state.activeRequestId,
        });
        return;
      }

      // POST /request
      if (method === "POST" && url === "/request") {
        const bodyStr = await readBody(req);
        let parsed: { question?: unknown; image_path?: unknown; context?: unknown };
        try {
          parsed = JSON.parse(bodyStr) as typeof parsed;
        } catch {
          sendJson(res, 400, { error: "invalid JSON body" });
          return;
        }

        const { question, image_path, context } = parsed;
        if (typeof question !== "string" || !question) {
          sendJson(res, 400, { error: "question (string) is required" });
          return;
        }

        const id = randomUUID();
        const entry: RequestEntry = {
          id,
          question,
          image_path: typeof image_path === "string" ? image_path : undefined,
          context: typeof context === "string" ? context : undefined,
          waiters: [],
        };
        state.requests.set(id, entry);
        state.sendQueue.push(id);

        log(`Request queued: ${id} (queue depth: ${state.sendQueue.length})`);
        sendJson(res, 200, { request_id: id });

        // Kick the dispatcher — sends immediately if no request is currently active
        void processQueue();
        return;
      }

      // GET /response/:id — long-poll up to longPollTimeoutMs
      const responseMatch = /^\/response\/([^/]+)$/.exec(url);
      if (method === "GET" && responseMatch) {
        const id = responseMatch[1];
        const entry = state.requests.get(id);
        if (!entry) {
          sendJson(res, 404, { error: "request not found" });
          return;
        }

        // Already answered — return immediately
        if (entry.answer !== undefined) {
          sendJson(res, 200, { answer: entry.answer });
          return;
        }

        // Telegram send already failed — return error immediately
        if (entry.failReason !== undefined) {
          sendJson(res, 502, { error: `Telegram error: ${entry.failReason}` });
          return;
        }

        // Long-poll: hold connection until answer arrives or timeout elapses
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            const idx = entry.waiters.indexOf(handler);
            if (idx !== -1) entry.waiters.splice(idx, 1);
            sendJson(res, 200, {}); // empty → client should retry
            resolve();
          }, longPollTimeoutMs);

          const handler = (answer: string | null) => {
            clearTimeout(timer);
            if (answer === null) {
              sendJson(res, 502, {
                error: `Telegram error: ${entry.failReason ?? "send failed"}`,
              });
            } else {
              sendJson(res, 200, { answer });
            }
            resolve();
          };
          entry.waiters.push(handler);
        });
        return;
      }

      sendJson(res, 404, { error: "not found" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Request handler error: ${msg}`);
      sendJson(res, 500, { error: msg });
    }
  };
}
