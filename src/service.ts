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

import { createServer, IncomingMessage, ServerResponse, Server } from "http";
import { readFile } from "fs/promises";
import { randomUUID } from "crypto";
import { basename, extname } from "path";

// ── Telegram types ───────────────────────────────────────────────────────────

interface TgMessage {
  message_id: number;
  chat: { id: number };
  text?: string;
  caption?: string;
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

// ── In-memory request store ──────────────────────────────────────────────────

interface RequestEntry {
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

// ── App factory ───────────────────────────────────────────────────────────────

export interface MeatbagApp {
  server: Server;
  /**
   * Deliver an answer to a pending request programmatically.
   * Used in tests to simulate a Telegram reply without running pollLoop.
   * Returns true if the request existed, false otherwise.
   */
  deliverAnswer: (requestId: string, answer: string) => boolean;
}

/**
 * Creates a fully wired HTTP server with its own isolated state.
 * Returns the http.Server and a deliverAnswer helper for tests.
 * Exported for testing.
 */
export function createMeatbagApp(botToken: string, chatId: string): MeatbagApp {
  const TG_API = `https://api.telegram.org/bot${botToken}`;

  // ── Telegram helpers (native fetch) ────────────────────────────────────────

  async function tgSendMessage(text: string): Promise<void> {
    const res = await fetch(`${TG_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!res.ok) {
      throw new Error(`sendMessage failed: ${res.status} ${await res.text()}`);
    }
  }

  async function tgSendPhoto(imagePath: string, caption: string): Promise<void> {
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
    form.append("chat_id", chatId);
    form.append("caption", caption);
    form.append("photo", blob, basename(imagePath));
    const res = await fetch(`${TG_API}/sendPhoto`, { method: "POST", body: form });
    if (!res.ok) {
      throw new Error(`sendPhoto failed: ${res.status} ${await res.text()}`);
    }
  }

  // tgGetUpdates exported for completeness; used by pollLoop in production.
  async function tgGetUpdates(offset: number, timeoutSecs: number): Promise<TgUpdate[]> {
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

  // ── State ──────────────────────────────────────────────────────────────────

  const requests = new Map<string, RequestEntry>();
  const sendQueue: string[] = [];
  let activeRequestId: string | null = null;
  let pollingOffset = 0;

  // ── Queue dispatcher ───────────────────────────────────────────────────────

  async function processQueue(): Promise<void> {
    if (activeRequestId !== null) return;
    if (sendQueue.length === 0) return;

    const id = sendQueue.shift()!;
    const entry = requests.get(id);
    if (!entry) {
      void processQueue();
      return;
    }

    activeRequestId = id;

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
      activeRequestId = null;
      const msg = tgErr instanceof Error ? tgErr.message : String(tgErr);
      process.stderr.write(`[meatbag-service] Telegram send failed for ${id}: ${msg}\n`);
      entry.failReason = msg;
      for (const waiter of entry.waiters) waiter(null);
      entry.waiters = [];
      void processQueue();
    }
  }

  // ── Long-poll Telegram loop ────────────────────────────────────────────────

  async function pollLoop(): Promise<void> {
    process.stderr.write("[meatbag-service] Telegram polling started\n");
    while (true) {
      try {
        const updates = await tgGetUpdates(pollingOffset, 30);
        for (const update of updates) {
          pollingOffset = update.update_id + 1;

          const msg = update.message;
          if (!msg) continue;
          if (String(msg.chat.id) !== chatId) continue;

          const text = msg.text ?? msg.caption ?? "";
          if (!text) continue;

          if (activeRequestId === null) {
            process.stderr.write("[meatbag-service] Received message but no active request\n");
            continue;
          }

          const id = activeRequestId;
          activeRequestId = null;

          const entry = requests.get(id);
          if (!entry) {
            void processQueue();
            continue;
          }

          process.stderr.write(`[meatbag-service] Answer received for request ${id}\n`);
          entry.answer = text;
          for (const waiter of entry.waiters) waiter(text);
          entry.waiters = [];

          void processQueue();
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("TimeoutError") && !msg.includes("AbortError")) {
          process.stderr.write(`[meatbag-service] Polling error: ${msg}\n`);
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    }
  }

  // ── HTTP helpers ───────────────────────────────────────────────────────────

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

  // ── HTTP server ────────────────────────────────────────────────────────────

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    try {
      // GET /health
      if (method === "GET" && url === "/health") {
        sendJson(res, 200, {
          status: "ok",
          queued: sendQueue.length,
          active: activeRequestId,
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
        requests.set(id, entry);
        sendQueue.push(id);

        process.stderr.write(`[meatbag-service] Request queued: ${id} (queue depth: ${sendQueue.length})\n`);
        sendJson(res, 200, { request_id: id });

        void processQueue();
        return;
      }

      // GET /response/:id — long-poll up to 30s
      const responseMatch = /^\/response\/([^/]+)$/.exec(url);
      if (method === "GET" && responseMatch) {
        const id = responseMatch[1];
        const entry = requests.get(id);
        if (!entry) {
          sendJson(res, 404, { error: "request not found" });
          return;
        }

        if (entry.answer !== undefined) {
          sendJson(res, 200, { answer: entry.answer });
          return;
        }

        if (entry.failReason !== undefined) {
          sendJson(res, 502, { error: `Telegram error: ${entry.failReason}` });
          return;
        }

        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            const idx = entry.waiters.indexOf(handler);
            if (idx !== -1) entry.waiters.splice(idx, 1);
            sendJson(res, 200, {});
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
  });

  // ── deliverAnswer (for testing) ────────────────────────────────────────────

  function deliverAnswer(requestId: string, answer: string): boolean {
    const entry = requests.get(requestId);
    if (!entry) return false;
    if (entry.answer !== undefined || entry.failReason !== undefined) return false;

    entry.answer = answer;
    activeRequestId = null;
    for (const waiter of entry.waiters) waiter(answer);
    entry.waiters = [];
    void processQueue();
    return true;
  }

  // ── pollLoop is started by the production entry point (require.main) ───────
  // Attach it to the server object so tests can optionally start it.
  (httpServer as unknown as { _startPollLoop: () => void })._startPollLoop = () => {
    void pollLoop();
  };

  return { server: httpServer, deliverAnswer };
}

// ── Start (only when run directly) ────────────────────────────────────────────

if (require.main === module) {
  const BOT_TOKEN = process.env.MEATBAG_BOT_TOKEN;
  const CHAT_ID = process.env.MEATBAG_CHAT_ID;
  const PORT = parseInt(process.env.MEATBAG_SERVICE_PORT ?? "7702", 10);

  if (!BOT_TOKEN) {
    process.stderr.write("[meatbag-service] MEATBAG_BOT_TOKEN env var is required\n");
    process.exit(1);
  }
  if (!CHAT_ID) {
    process.stderr.write("[meatbag-service] MEATBAG_CHAT_ID env var is required\n");
    process.exit(1);
  }

  const { server: httpServer } = createMeatbagApp(BOT_TOKEN, CHAT_ID);

  httpServer.listen(PORT, "127.0.0.1", () => {
    process.stderr.write(`[meatbag-service] Listening on http://127.0.0.1:${PORT}\n`);
    (httpServer as unknown as { _startPollLoop: () => void })._startPollLoop();
  });

  httpServer.on("error", (err) => {
    process.stderr.write(`[meatbag-service] HTTP server error: ${err.message}\n`);
    process.exit(1);
  });
}
