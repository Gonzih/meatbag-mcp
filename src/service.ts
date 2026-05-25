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
import { tgSendMessage, tgSendPhoto, tgGetUpdates, TgUpdate } from "./tg-api";
import {
  createServiceState,
  createProcessQueue,
  createHttpHandler,
  RequestEntry,
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

// ── Wiring ────────────────────────────────────────────────────────────────────

const log = (msg: string): void => {
  process.stderr.write(`[meatbag-service] ${msg}\n`);
};

const state = createServiceState();

/** Sends the active entry's question to Telegram (message or photo). */
const tgSend = async (entry: RequestEntry, tgText: string): Promise<void> => {
  if (entry.image_path) {
    await tgSendPhoto(TG_API, CHAT_ID as string, entry.image_path, tgText);
  } else {
    await tgSendMessage(TG_API, CHAT_ID as string, tgText);
  }
};

const processQueue = createProcessQueue(state, tgSend, log);
const httpHandler = createHttpHandler(state, processQueue, log);

// ── Long-poll Telegram loop ──────────────────────────────────────────────────

let pollingOffset = 0;

/**
 * Continuous Telegram poll loop — runs forever as a daemon.
 * Routes each incoming message to the active request (the one currently shown
 * in Telegram). After answering, triggers processQueue() to send the next one.
 */
async function pollLoop(): Promise<void> {
  log("Telegram polling started");
  while (true) {
    try {
      const updates: TgUpdate[] = await tgGetUpdates(TG_API, pollingOffset, 30);
      for (const update of updates) {
        pollingOffset = update.update_id + 1;

        const msg = update.message;
        if (!msg) continue;
        if (String(msg.chat.id) !== CHAT_ID) continue;

        const text = msg.text ?? msg.caption ?? "";
        if (!text) continue;

        // Match reply to the active (currently visible) request
        if (state.activeRequestId === null) {
          log("Received message but no active request");
          continue;
        }

        const id = state.activeRequestId;
        state.activeRequestId = null; // release slot before notifying waiters

        const entry = state.requests.get(id);
        if (!entry) {
          void processQueue();
          continue;
        }

        log(`Answer received for request ${id}`);
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
        log(`Polling error: ${msg}`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
}

// ── HTTP server ───────────────────────────────────────────────────────────────

const httpServer = createServer(httpHandler);

// ── Start ─────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, "127.0.0.1", () => {
  log(`Listening on http://127.0.0.1:${PORT}`);
  void pollLoop();
});

httpServer.on("error", (err) => {
  log(`HTTP server error: ${err.message}`);
  process.exit(1);
});
