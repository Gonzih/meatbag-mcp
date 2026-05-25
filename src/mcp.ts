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
import { requestHumanInput } from "./mcp-client";

// ── Config ──────────────────────────────────────────────────────────────────

const SERVICE_URL = process.env.MEATBAG_SERVICE_URL ?? "http://localhost:7702";

// ── MCP Server ────────────────────────────────────────────────────────────────

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
    const answer = await requestHumanInput(SERVICE_URL, args.question, image_path);
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

// ── Start ─────────────────────────────────────────────────────────────────────

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
