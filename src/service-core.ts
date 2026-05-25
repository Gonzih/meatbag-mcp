/**
 * service-core.ts — ServiceCore class + HTTP utilities
 *
 * Contains all testable logic with no module-level side effects.
 * Imported by service.ts (the entry-point) and by tests.
 */

import { IncomingMessage, ServerResponse } from "http";
import { readFile } from "fs/promises";
import { randomUUID } from "crypto";
import { basename, extname } from "path";

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

// ── Request store types ──────────────────────────────────────────────────────

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

// ── HTTP utilities ───────────────────────────────────────────────────────────

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

// ── ServiceCore class ────────────────────────────────────────────────────────

export class ServiceCore {
  readonly requests: Map<string, RequestEntry> = new Map();
  readonly sendQueue: string[] = [];
  activeRequestId: string | null = null;
  pollingOffset: number = 0;

  private readonly tgApi: string;
  private readonly chatId: string;

  constructor(botToken: string, chatId: string) {
    this.tgApi = `https://api.telegram.org/bot${botToken}`;
    this.chatId = chatId;
  }

  // ── Telegram helpers ─────────────────────────────────────────────────────

  async tgSendMessage(text: string): Promise<void> {
    const res = await fetch(`${this.tgApi}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: this.chatId, text }),
    });
    if (!res.ok) {
      throw new Error(`sendMessage failed: ${res.status} ${await res.text()}`);
    }
  }

  async tgSendPhoto(imagePath: string, caption: string): Promise<void> {
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
    form.append("chat_id", this.chatId);
    form.append("caption", caption);
    form.append("photo", blob, basename(imagePath));
    const res = await fetch(`${this.tgApi}/sendPhoto`, { method: "POST", body: form });
    if (!res.ok) {
      throw new Error(`sendPhoto failed: ${res.status} ${await res.text()}`);
    }
  }

  async tgGetUpdates(offset: number, timeoutSecs: number): Promise<TgUpdate[]> {
    const res = await fetch(`${this.tgApi}/getUpdates`, {
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

  // ── Queue dispatcher ─────────────────────────────────────────────────────

  /**
   * Sends the next queued request to Telegram if no request is currently active.
   * Idempotent: safe to call multiple times concurrently.
   */
  async processQueue(): Promise<void> {
    if (this.activeRequestId !== null) return;
    if (this.sendQueue.length === 0) return;

    const id = this.sendQueue.shift()!;
    const entry = this.requests.get(id);
    if (!entry) {
      // Entry was removed (shouldn't happen normally) — try next
      void this.processQueue();
      return;
    }

    // Claim the active slot before any await to prevent concurrent sends
    this.activeRequestId = id;

    let tgText = entry.question;
    if (entry.context) tgText = `[Context: ${entry.context}]\n\n${entry.question}`;

    try {
      if (entry.image_path) {
        await this.tgSendPhoto(entry.image_path, tgText);
      } else {
        await this.tgSendMessage(tgText);
      }
      process.stderr.write(`[meatbag-service] Sent to Telegram: ${id}\n`);
    } catch (tgErr) {
      // Send failed — release the active slot and notify waiters of the error
      this.activeRequestId = null;
      const msg = tgErr instanceof Error ? tgErr.message : String(tgErr);
      process.stderr.write(`[meatbag-service] Telegram send failed for ${id}: ${msg}\n`);
      entry.failReason = msg;
      for (const waiter of entry.waiters) waiter(null);
      entry.waiters = [];
      void this.processQueue();
    }
  }

  // ── Telegram update handler ──────────────────────────────────────────────

  /**
   * Handles a single Telegram update. Extracted from pollLoop for testability.
   */
  async handleUpdate(update: TgUpdate): Promise<void> {
    const msg = update.message;
    if (!msg) return;
    if (String(msg.chat.id) !== this.chatId) return;

    const text = msg.text ?? msg.caption ?? "";
    if (!text) return;

    if (this.activeRequestId === null) {
      process.stderr.write("[meatbag-service] Received message but no active request\n");
      return;
    }

    const id = this.activeRequestId;
    this.activeRequestId = null; // release slot before notifying waiters

    const entry = this.requests.get(id);
    if (!entry) {
      void this.processQueue();
      return;
    }

    process.stderr.write(`[meatbag-service] Answer received for request ${id}\n`);
    entry.answer = text;
    for (const waiter of entry.waiters) waiter(text);
    entry.waiters = [];

    void this.processQueue();
  }

  // ── HTTP request handler ─────────────────────────────────────────────────

  /**
   * Returns an async HTTP handler function suitable for http.createServer().
   */
  createRequestHandler(): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
    return async (req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? "/";
      const method = req.method ?? "GET";

      try {
        // GET /health
        if (method === "GET" && url === "/health") {
          sendJson(res, 200, {
            status: "ok",
            queued: this.sendQueue.length,
            active: this.activeRequestId,
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
          this.requests.set(id, entry);
          this.sendQueue.push(id);

          process.stderr.write(
            `[meatbag-service] Request queued: ${id} (queue depth: ${this.sendQueue.length})\n`
          );
          sendJson(res, 200, { request_id: id });

          void this.processQueue();
          return;
        }

        // GET /response/:id — long-poll up to 30s
        const responseMatch = /^\/response\/([^/]+)$/.exec(url);
        if (method === "GET" && responseMatch) {
          const id = responseMatch[1];
          const entry = this.requests.get(id);
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

  // ── Long-poll Telegram loop ──────────────────────────────────────────────

  /**
   * Continuous Telegram poll loop — runs forever as a daemon.
   */
  async pollLoop(): Promise<void> {
    process.stderr.write("[meatbag-service] Telegram polling started\n");
    while (true) {
      try {
        const updates = await this.tgGetUpdates(this.pollingOffset, 30);
        for (const update of updates) {
          this.pollingOffset = update.update_id + 1;
          await this.handleUpdate(update);
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
}
