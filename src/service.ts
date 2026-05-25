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

import { createServer } from "http";
import { readFile } from "fs/promises";
import { basename, extname } from "path";
import {
  createServiceState,
  createHttpHandler,
  processQueue,
  TgUpdate,
} from "./service-core";

// ── Config ──────────────────────────────────────────────────────────────────

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

const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ── Telegram implementations ─────────────────────────────────────────────────

async function tgSendMessage(text: string): Promise<void> {
  const res = await fetch(`${TG_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text }),
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
  form.append("chat_id", CHAT_ID as string);
  form.append("caption", caption);
  form.append("photo", blob, basename(imagePath));
  const res = await fetch(`${TG_API}/sendPhoto`, { method: "POST", body: form });
  if (!res.ok) {
    throw new Error(`sendPhoto failed: ${res.status} ${await res.text()}`);
  }
}

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

// ── Service setup ─────────────────────────────────────────────────────────────

const state = createServiceState();
const tg = { sendMessage: tgSendMessage, sendPhoto: tgSendPhoto };
const handler = createHttpHandler(state, tg);

// ── Long-poll Telegram loop ──────────────────────────────────────────────────

let pollingOffset = 0;

/**
 * Continuous Telegram poll loop — runs forever as a daemon.
 * Routes each incoming message to the active request (the one currently shown
 * in Telegram). After answering, triggers processQueue() to send the next one.
 */
async function pollLoop(): Promise<void> {
  process.stderr.write("[meatbag-service] Telegram polling started\n");
  while (true) {
    try {
      const updates = await tgGetUpdates(pollingOffset, 30);
      for (const update of updates) {
        pollingOffset = update.update_id + 1;

        const msg = update.message;
        if (!msg) continue;
        if (String(msg.chat.id) !== CHAT_ID) continue;

        const text = msg.text ?? msg.caption ?? "";
        if (!text) continue;

        // Match reply to the active (currently visible) request
        if (state.activeRequestId === null) {
          process.stderr.write("[meatbag-service] Received message but no active request\n");
          continue;
        }

        const id = state.activeRequestId;
        state.activeRequestId = null; // release slot before notifying waiters

        const entry = state.requests.get(id);
        if (!entry) {
          void processQueue(state, tg);
          continue;
        }

        process.stderr.write(`[meatbag-service] Answer received for request ${id}\n`);
        entry.answer = text;
        for (const waiter of entry.waiters) waiter(text);
        entry.waiters = [];

        // Send the next queued request now that the slot is free
        void processQueue(state, tg);
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

// ── Start ─────────────────────────────────────────────────────────────────────

const httpServer = createServer((req, res) => {
  handler(req, res).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[meatbag-service] Unhandled handler error: ${msg}\n`);
  });
});

httpServer.listen(PORT, "127.0.0.1", () => {
  process.stderr.write(`[meatbag-service] Listening on http://127.0.0.1:${PORT}\n`);
  void pollLoop();
});

httpServer.on("error", (err) => {
  process.stderr.write(`[meatbag-service] HTTP server error: ${err.message}\n`);
  process.exit(1);
});
