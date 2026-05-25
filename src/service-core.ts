/**
 * service-core — pure business logic for meatbag-service
 *
 * No env-var reads, no server startup, no Telegram credentials.
 * All Telegram I/O is injected via TelegramSender so tests can mock it.
 */

import { IncomingMessage, ServerResponse } from "http";
import { randomUUID } from "crypto";

// ── Telegram types ───────────────────────────────────────────────────────────

export interface TgMessage {
  message_id: number;
  chat: { id: number };
  text?: string;
  caption?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

// ── Request store types ───────────────────────────────────────────────────────

export interface RequestEntry {
  id: string;
  question: string;
  image_path?: string;
  context?: string;
  answer?: string;
  /** Set when Telegram send failed — waiters receive null */
  failReason?: string;
  /** Callbacks registered by GET /response/:id long-pollers. null = failure. */
  waiters: Array<(answer: string | null) => void>;
}

// ── Telegram sender interface (injected) ─────────────────────────────────────

export interface TelegramSender {
  sendMessage(text: string): Promise<void>;
  sendPhoto(imagePath: string, caption: string): Promise<void>;
}

// ── Service state ─────────────────────────────────────────────────────────────

export interface ServiceState {
  /** All tracked requests, keyed by UUID */
  requests: Map<string, RequestEntry>;
  /** FIFO queue of request IDs whose Telegram message has NOT been sent yet */
  sendQueue: string[];
  /** The request currently shown in Telegram. null when idle. */
  activeRequestId: string | null;
}

export function createServiceState(): ServiceState {
  return {
    requests: new Map(),
    sendQueue: [],
    activeRequestId: null,
  };
}

// ── HTTP utilities ────────────────────────────────────────────────────────────

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

// ── Queue dispatcher ──────────────────────────────────────────────────────────

/**
 * Sends the next queued request to Telegram if no request is currently active.
 * Idempotent and re-entrant-safe: returns immediately when activeRequestId is set
 * (the check and the assignment both happen before any await).
 */
export async function processQueue(state: ServiceState, tg: TelegramSender): Promise<void> {
  if (state.activeRequestId !== null) return;
  if (state.sendQueue.length === 0) return;

  const id = state.sendQueue.shift()!;
  const entry = state.requests.get(id);
  if (!entry) {
    // Entry removed (shouldn't happen in normal flow) — try next
    void processQueue(state, tg);
    return;
  }

  // Claim the active slot before any await to prevent concurrent sends
  state.activeRequestId = id;

  let tgText = entry.question;
  if (entry.context) tgText = `[Context: ${entry.context}]\n\n${entry.question}`;

  try {
    if (entry.image_path) {
      await tg.sendPhoto(entry.image_path, tgText);
    } else {
      await tg.sendMessage(tgText);
    }
    process.stderr.write(`[meatbag-service] Sent to Telegram: ${id}\n`);
  } catch (tgErr) {
    // Send failed — release slot and notify waiters
    state.activeRequestId = null;
    const msg = tgErr instanceof Error ? tgErr.message : String(tgErr);
    process.stderr.write(`[meatbag-service] Telegram send failed for ${id}: ${msg}\n`);
    entry.failReason = msg;
    for (const waiter of entry.waiters) waiter(null);
    entry.waiters = [];
    void processQueue(state, tg);
  }
}

// ── HTTP handler options ──────────────────────────────────────────────────────

export interface HttpHandlerOptions {
  /** How long GET /response/:id holds the connection before returning {}. Default 30s. */
  longPollTimeoutMs?: number;
}

// ── HTTP handler factory ──────────────────────────────────────────────────────

/**
 * Returns the HTTP request handler for meatbag-service.
 * All Telegram I/O is routed through the injected `tg` sender.
 */
export function createHttpHandler(
  state: ServiceState,
  tg: TelegramSender,
  options: HttpHandlerOptions = {}
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { longPollTimeoutMs = 30_000 } = options;

  return async (req, res) => {
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

        process.stderr.write(
          `[meatbag-service] Request queued: ${id} (queue depth: ${state.sendQueue.length})\n`
        );
        sendJson(res, 200, { request_id: id });

        void processQueue(state, tg);
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

        // Long-poll: hold connection until answer arrives or timeout
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
      process.stderr.write(`[meatbag-service] Request handler error: ${msg}\n`);
      sendJson(res, 500, { error: msg });
    }
  };
}
