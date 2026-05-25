#!/usr/bin/env node
/**
 * meatbag-mcp — thin MCP client
 *
 * Exposes one MCP tool: request_human_input
 * Delegates all work to meatbag-service running on localhost:7702.
 * No Telegram connection — zero Telegram-related dependencies.
 *
 * Usage:
 *   MEATBAG_SERVICE_URL=http://localhost:7702 npx meatbag-mcp
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ── Config ──────────────────────────────────────────────────────────────────

export const SERVICE_URL = process.env.MEATBAG_SERVICE_URL ?? "http://localhost:7702";
export const POLL_INTERVAL_MS = 2_000;
export const MAX_WAIT_MS = 5 * 60 * 1_000; // 5 minutes total

// ── Service client ───────────────────────────────────────────────────────────

export async function postRequest(
  question: string,
  image_path?: string
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${SERVICE_URL}/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, image_path }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `meatbag-service is not running on ${SERVICE_URL}: ${msg}\n` +
        `Start it with: MEATBAG_BOT_TOKEN=<token> MEATBAG_CHAT_ID=<id> meatbag-service`
    );
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`POST ${SERVICE_URL}/request failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as { request_id?: string; error?: string };
  if (!data.request_id) {
    throw new Error(`Service returned no request_id: ${JSON.stringify(data)}`);
  }
  return data.request_id;
}

export async function pollResponse(requestId: string): Promise<string> {
  const deadline = Date.now() + MAX_WAIT_MS;

  while (Date.now() < deadline) {
    let res: Response;
    try {
      // GET /response/:id long-polls for up to 30s on the server side
      res = await fetch(`${SERVICE_URL}/response/${requestId}`, {
        signal: AbortSignal.timeout(35_000), // 30s server long-poll + 5s buffer
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`GET ${SERVICE_URL}/response/${requestId} failed: ${msg}`);
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GET /response/${requestId} returned ${res.status}: ${body}`);
    }

    const data = (await res.json()) as { answer?: string };
    if (data.answer !== undefined) {
      return data.answer;
    }

    // Server timed out with no answer — wait briefly and retry
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  throw new Error("Timed out waiting for human response (5 minutes)");
}

export async function requestHumanInput(
  question: string,
  image_path?: string
): Promise<string> {
  const requestId = await postRequest(question, image_path);
  return pollResponse(requestId);
}

// ── MCP Server ────────────────────────────────────────────────────────────────

if (require.main === module) {
  const server = new Server(
    { name: "meatbag-mcp", version: "1.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "request_human_input",
        description:
          "Send a message to the human operator via Telegram and wait for their reply. " +
          "Use this when you need a human decision, approval, captcha solution, or free-text input. " +
          "Requires meatbag-service to be running on localhost:7702.",
        inputSchema: {
          type: "object",
          properties: {
            question: {
              type: "string",
              description: "The question or prompt to send to the human operator.",
            },
            image_path: {
              type: "string",
              description:
                "Optional absolute path to an image file to send along with the question.",
            },
          },
          required: ["question"],
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
      question?: unknown;
      image_path?: unknown;
    };

    if (!args.question || typeof args.question !== "string") {
      return {
        content: [{ type: "text", text: "question (string) argument is required" }],
        isError: true,
      };
    }

    const image_path =
      typeof args.image_path === "string" ? args.image_path : undefined;

    try {
      const answer = await requestHumanInput(args.question, image_path);
      return {
        content: [{ type: "text", text: answer }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${msg}` }],
        isError: true,
      };
    }
  });

  async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    process.stderr.write(
      `[meatbag-mcp] Server running on stdio (service: ${SERVICE_URL})\n`
    );
  }

  main().catch((err) => {
    process.stderr.write(
      `[meatbag-mcp] Fatal: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(1);
  });
}
