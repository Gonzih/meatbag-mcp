#!/usr/bin/env node
/**
 * meatbag-service — entry point
 *
 * Reads env vars, wires up ServiceCore, and starts the HTTP server + poll loop.
 * All logic lives in service-core.ts.
 */

import { createServer } from "http";
import { ServiceCore } from "./service-core";

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

// ── Start ─────────────────────────────────────────────────────────────────────

const core = new ServiceCore(BOT_TOKEN, CHAT_ID);
const handler = core.createRequestHandler();

const httpServer = createServer(async (req, res) => {
  await handler(req, res);
});

httpServer.listen(PORT, "127.0.0.1", () => {
  process.stderr.write(`[meatbag-service] Listening on http://127.0.0.1:${PORT}\n`);
  void core.pollLoop();
});

httpServer.on("error", (err) => {
  process.stderr.write(`[meatbag-service] HTTP server error: ${err.message}\n`);
  process.exit(1);
});
