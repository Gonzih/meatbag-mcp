#!/usr/bin/env node
/**
 * meatbag-service — central Telegram bot + HTTP API
 *
 * Runs as a persistent daemon. Owns the single Telegram bot connection.
 * All meatbag-mcp instances delegate to this service via HTTP on localhost:7702.
 *
 * Sequential queue: only one question is visible in Telegram at a time.
 * Incoming requests are held in sendQueue until the active request is answered.
 *
 * API:
 *   POST /request          { question, image_path?, context? } → { request_id }
 *   GET  /response/:id     long-polls (≤30s) until answer ready → { answer } or {}
 *   GET  /health           → { status: "ok", queued, active }
 */

import { createServer, IncomingMessage, ServerResponse } from "http";
import { readFile } from "fs/promises";
import { randomUUID } from "crypto";
import { basename, extname } from "path";

// ── Config ──────────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env.MEATBAG_BOT_TOKEN;
const CHAT_ID = process.env.MEATBAG_CHAT_ID;
const PORT = parseInt(process.env.MEATBAG_SERVICE_PORT ?? "7702", 10);
const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

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

// ── Telegram helpers (native fetch) ──────────────────────────────────────────

export async function tgSendMessage(text: string): Promise<void> {
  const res = await fetch(`${TG_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text }),
  });
  if (!res.ok) {
    throw new Error(`sendMessage failed: ${res.status} ${await res.text()}`);
  }
}

export async function tgSendPhoto(imagePath: string, caption: string): Promise<void> {
  const imageData = await readFile(imagePath);
  const ext = extname(imagePath).toLowerCase();
  const mimeMap: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
  };
  const mimeType = mimeMap[ext] ?? "image/jpeg";
  const blob = new Blob([imageData], { type: mimeType });
  const form = new FormData();
  form.append("chat_id", CHAT_ID as string);
  form.append("caption", caption);
  form.append("photo", blob, basename(imagePath));
  const res = await fetch(`${TG_API}/sendPhoto`, { method: "POST", body: form });
  if (!res.ok) {
    throw new Error(`sendPhoto failed: ${res.status} ${await res.text()}`);
  }
}

export async function tgGetUpdates(offset: number, timeoutSecs: number): Promise<TgUpdate[]> {
  const res = await fetch(`${TG_API}/getUpdates`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ offset, timeout: timeoutSecs, allowed_updates: ["message"] }),
    signal: AbortSignal.timeout((timeoutSecs + 5) * 1000),
  });
  if (!res.ok) {
    throw new Error(`getUpdates failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { ok: boolean; result: TgUpdate[] };
  return data.result ?? [];
}

// ── In-memory request store ──────────────────────────────────────────────────

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
 * Mutable module state — exported as a single object so tests can inspect
 * and reset it between cases via _resetState().
 */
export const _state = {
  /** All tracked requests */
  requests: new Map<string, RequestEntry>(),
  /**
   * FIFO queue of request IDs whose Telegram message has NOT been sent yet.
   * Only the active request is visible in Telegram at any time.
   */
  sendQueue: [] as string[],
  /**
   * The request currently shown in Telegram (message sent, awaiting reply).
   * null when no request is active.
   */
  activeRequestId: null as string | null,
  /** Telegram long-poll update offset */
  pollingOffset: 0,
};

/** Reset all in-memory state. Use in tests between cases. */
export function _resetState(): void {
  _state.requests.clear();
  _state.sendQueue.length = 0;
  _state.activeRequestId = null;
  _state.pollingOffset = 0;
}

// ── Queue dispatcher ──────────────────────────────────────────────────────────

/**
 * Sends the next queued request to Telegram if no request is currently active.
 * Idempotent: safe to call multiple times concurrently.
 */
export async function processQueue(): Promise<void> {
  // Another request is already active — wait for its reply before sending next
  if (_state.activeRequestId !== null) return;
  if (_state.sendQueue.length === 0) return;

  const id = _state.sendQueue.shift()!;
  const entry = _state.requests.get(id);
  if (!entry) {
    // Entry was removed (shouldn't happen normally) — try next
    void processQueue();
    return;
  }

  // Claim the active slot before any await to prevent concurrent sends
  _state.activeRequestId = id;

  let tgText = entry.question;
  if (entry.context) tgText = `[Context: ${entry.context}]\n\n${entry.question}`;

  try {
    if (entry.image_path) {
      await tgSendPhoto(entry.image_path, tgText);
    } else {
      await tgSendMessage(tgText);
    }
    process.stderr.write(`[meatbag-service] Sent to Telegram: ${id}\n`);
  } catch (tgErr) {
    // Send failed — release the active slot and notify waiters of the error
    _state.activeRequestId = null;
    const msg = tgErr instanceof Error ? tgErr.message : String(tgErr);
    process.stderr.write(`[meatbag-service] Telegram send failed for ${id}: ${msg}\n`);
    entry.failReason = msg;
    for (const waiter of entry.waiters) waiter(null);
    entry.waiters = [];
    // Try to send the next queued request
    void processQueue();
  }
}

// ── Long-poll Telegram loop ──────────────────────────────────────────────────

/**
 * Continuous Telegram poll loop — runs forever as a daemon.
 * Routes each incoming message to the active request (the one currently shown
 * in Telegram). After answering, triggers processQueue() to send the next one.
 */
export async function pollLoop(): Promise<void> {
  process.stderr.write("[meatbag-service] Telegram polling started\n");
  while (true) {
    try {
      const updates = await tgGetUpdates(_state.pollingOffset, 30);
      for (const update of updates) {
        _state.pollingOffset = update.update_id + 1;

        const msg = update.message;
        if (!msg) continue;
        if (String(msg.chat.id) !== CHAT_ID) continue;

        const text = msg.text ?? msg.caption ?? "";
        if (!text) continue;

        // Match reply to the active (currently visible) request
        if (_state.activeRequestId === null) {
          process.stderr.write("[meatbag-service] Received message but no active request\n");
          continue;
        }

        const id = _state.activeRequestId;
        _state.activeRequestId = null; // release slot before notifying waiters

        const entry = _state.requests.get(id);
        if (!entry) {
          void processQueue();
          continue;
        }

        process.stderr.write(`[meatbag-service] Answer received for request ${id}\n`);
        entry.answer = text;
        for (const waiter of entry.waiters) waiter(text);
        entry.waiters = [];

        // Send the next queued request now that the slot is free
        void processQueue();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // AbortError / TimeoutError are expected from the long-poll timeout
      if (!msg.includes("TimeoutError") && !msg.includes("AbortError")) {
        process.stderr.write(`[meatbag-service] Polling error: ${msg}\n`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

// ── HTTP handler ──────────────────────────────────────────────────────────────

/**
 * Core HTTP request handler. Exported so tests can mount it on a server
 * without triggering the startup side-effects (env checks, pollLoop).
 */
export async function httpHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  try {
    // GET /health
    if (method === "GET" && url === "/health") {
      sendJson(res, 200, {
        status: "ok",
        queued: _state.sendQueue.length,
        active: _state.activeRequestId,
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
      _state.requests.set(id, entry);
      _state.sendQueue.push(id);

      process.stderr.write(`[meatbag-service] Request queued: ${id} (queue depth: ${_state.sendQueue.length})\n`);
      sendJson(res, 200, { request_id: id });

      // Kick the dispatcher — will send immediately if no request is active
      void processQueue();
      return;
    }

    // GET /response/:id — long-poll up to 30s
    const responseMatch = /^\/response\/([^/]+)$/.exec(url);
    if (method === "GET" && responseMatch) {
      const id = responseMatch[1];
      const entry = _state.requests.get(id);
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

      // Long-poll: hold connection until answer arrives or 30s elapses
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          const idx = entry.waiters.indexOf(handler);
          if (idx !== -1) entry.waiters.splice(idx, 1);
          sendJson(res, 200, {}); // empty → client should retry
          resolve();
        }, 30_000);

        const handler = (answer: string | null) => {
          clearTimeout(timer);
          if (answer === null) {
            sendJson(res, 502, { error: `Telegram error: ${entry.failReason ?? "send failed"}` });
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
}

// ── Start ─────────────────────────────────────────────────────────────────────

if (require.main === module) {
  if (!BOT_TOKEN) {
    process.stderr.write("[meatbag-service] MEATBAG_BOT_TOKEN env var is required\n");
    process.exit(1);
  }
  if (!CHAT_ID) {
    process.stderr.write("[meatbag-service] MEATBAG_CHAT_ID env var is required\n");
    process.exit(1);
  }

  const httpServer = createServer(httpHandler);

  httpServer.listen(PORT, "127.0.0.1", () => {
    process.stderr.write(`[meatbag-service] Listening on http://127.0.0.1:${PORT}\n`);
    void pollLoop();
  });

  httpServer.on("error", (err) => {
    process.stderr.write(`[meatbag-service] HTTP server error: ${err.message}\n`);
    process.exit(1);
  });
}
