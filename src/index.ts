#!/usr/bin/env node
/**
 * meatbag-mcp — Human-in-the-loop MCP server via Telegram
 *
 * Exposes a single MCP tool: request_human_input
 * When called, sends a Telegram message and waits for the next reply.
 * Uses a FIFO queue: the oldest pending request gets the next reply.
 *
 * Uses Node 18+ built-in fetch to call the Telegram Bot API directly —
 * no third-party Telegram library needed, zero extra dependency attack surface.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ── Config ──────────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env.MEATBAG_BOT_TOKEN;
const CHAT_ID = process.env.MEATBAG_CHAT_ID;
const DEFAULT_TIMEOUT = parseInt(
  process.env.MEATBAG_TIMEOUT_SECONDS ?? "120",
  10
);

if (!BOT_TOKEN) {
  process.stderr.write("[meatbag-mcp] MEATBAG_BOT_TOKEN env var is required\n");
  process.exit(1);
}
if (!CHAT_ID) {
  process.stderr.write("[meatbag-mcp] MEATBAG_CHAT_ID env var is required\n");
  process.exit(1);
}

const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ── Telegram helpers (native fetch) ──────────────────────────────────────────

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

async function tgSendMessage(chatId: string, text: string): Promise<void> {
  const res = await fetch(`${TG_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram sendMessage failed: ${res.status} ${body}`);
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
    const body = await res.text();
    throw new Error(`Telegram getUpdates failed: ${res.status} ${body}`);
  }
  const data = (await res.json()) as { ok: boolean; result: TgUpdate[] };
  return data.result ?? [];
}

// ── Pending request queue ────────────────────────────────────────────────────

interface PendingRequest {
  resolve: (answer: string) => void;
  reject: (err: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

const pendingQueue: PendingRequest[] = [];

// ── Long-poll loop ───────────────────────────────────────────────────────────

let pollingOffset = 0;
let pollingActive = false;

/**
 * Start background long-polling loop.
 * Runs only when there are pending requests; stops itself when the queue empties.
 */
function ensurePolling(): void {
  if (pollingActive) return;
  pollingActive = true;
  void pollLoop();
}

async function pollLoop(): Promise<void> {
  while (pendingQueue.length > 0) {
    try {
      const updates = await tgGetUpdates(pollingOffset, 30);
      for (const update of updates) {
        pollingOffset = update.update_id + 1;

        const msg = update.message;
        if (!msg) continue;
        if (String(msg.chat.id) !== CHAT_ID) continue;

        const text = msg.text ?? msg.caption ?? "";
        if (!text) continue;

        const pending = pendingQueue.shift();
        if (!pending) continue;

        clearTimeout(pending.timeoutHandle);
        pending.resolve(text);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // Ignore timeout errors from AbortSignal — they're expected
      if (!errMsg.includes("TimeoutError") && !errMsg.includes("AbortError")) {
        process.stderr.write(`[meatbag-mcp] Polling error: ${errMsg}\n`);
      }
      // Brief back-off before retrying to avoid hammering the API
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  pollingActive = false;
}

// ── Core logic ────────────────────────────────────────────────────────────────

async function requestHumanInput(
  message: string,
  options?: string[],
  timeoutSeconds: number = DEFAULT_TIMEOUT
): Promise<{ answer: string; timed_out: boolean }> {
  // Build the Telegram message text
  let text = message;
  if (options && options.length > 0) {
    text += "\n\nOptions:";
    options.forEach((opt, i) => {
      text += `\n${i + 1}. ${opt}`;
    });
    text += "\n\nReply with the option number or your own answer.";
  }

  await tgSendMessage(CHAT_ID as string, text);

  return new Promise((resolve) => {
    const timeoutHandle = setTimeout(() => {
      const idx = pendingQueue.findIndex((p) => p.timeoutHandle === timeoutHandle);
      if (idx !== -1) pendingQueue.splice(idx, 1);
      resolve({ answer: "", timed_out: true });
    }, timeoutSeconds * 1000);

    pendingQueue.push({
      resolve: (answer: string) => resolve({ answer, timed_out: false }),
      reject: (err: Error) => {
        process.stderr.write(`[meatbag-mcp] Request rejected: ${err.message}\n`);
        resolve({ answer: "", timed_out: true });
      },
      timeoutHandle,
    });

    // Kick off polling if not already running
    ensurePolling();
  });
}

// ── MCP Server ────────────────────────────────────────────────────────────────

const server = new Server(
  { name: "meatbag-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "request_human_input",
      description:
        "Send a message to the human operator via Telegram and wait for their reply. Use this when you need a human decision, approval, captcha solution, or free-text input.",
      inputSchema: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "The question or prompt to send to the human operator.",
          },
          options: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional list of choices. If provided, they are shown as a numbered list and the user can reply with a number.",
          },
          timeout_seconds: {
            type: "number",
            description: `How long to wait for a reply in seconds (default: ${DEFAULT_TIMEOUT}).`,
          },
        },
        required: ["message"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "request_human_input") {
    return {
      content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
      isError: true,
    };
  }

  const args = request.params.arguments as {
    message: string;
    options?: string[];
    timeout_seconds?: number;
  };

  if (!args.message || typeof args.message !== "string") {
    return {
      content: [{ type: "text", text: "message argument is required" }],
      isError: true,
    };
  }

  try {
    const result = await requestHumanInput(
      args.message,
      args.options,
      args.timeout_seconds
    );
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error: ${msg}` }],
      isError: true,
    };
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[meatbag-mcp] Server running on stdio\n");
}

main().catch((err) => {
  process.stderr.write(`[meatbag-mcp] Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
