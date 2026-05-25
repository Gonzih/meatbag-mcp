/**
 * Unit tests for mcp.ts
 *
 * Strategy:
 * - Mock @modelcontextprotocol/sdk to capture MCP request handlers
 * - Mock global fetch to control service responses
 * - Drive postRequest / pollResponse / MCP handlers through captured closures
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── capture MCP handler registrations ────────────────────────────────────────

type AnyHandler = (req: unknown) => Promise<unknown>;

const capturedHandlers: Record<string, AnyHandler> = {};
const mockSetRequestHandler = vi.fn((schema: { method: string }, handler: AnyHandler) => {
  capturedHandlers[schema.method] = handler;
});

const mockConnect = vi.fn().mockResolvedValue(undefined);
const MockServer = vi.fn().mockImplementation(() => ({
  setRequestHandler: mockSetRequestHandler,
  connect: mockConnect,
}));
const MockStdioServerTransport = vi.fn().mockImplementation(() => ({}));

vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({
  Server: MockServer,
}));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: MockStdioServerTransport,
}));
vi.mock("@modelcontextprotocol/sdk/types.js", () => ({
  ListToolsRequestSchema: { method: "tools/list" },
  CallToolRequestSchema: { method: "tools/call" },
}));

// ── mock fetch ────────────────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ── helpers ───────────────────────────────────────────────────────────────────

function makeOkResponse(body: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  } as Response);
}

function makeErrResponse(status: number, body: string) {
  return Promise.resolve({
    ok: false,
    status,
    text: () => Promise.resolve(body),
    json: () => Promise.resolve({ error: body }),
  } as Response);
}

// ── import mcp (triggers module-level side effects) ───────────────────────────

await import("../mcp");

// ── reset between tests ───────────────────────────────────────────────────────

beforeEach(() => {
  mockFetch.mockReset();
});

// ═════════════════════════════════════════════════════════════════════════════
// MCP Server setup
// ═════════════════════════════════════════════════════════════════════════════

describe("MCP server setup", () => {
  it("instantiated Server and registered two handlers", () => {
    expect(MockServer).toHaveBeenCalledTimes(1);
    expect(mockSetRequestHandler).toHaveBeenCalledTimes(2);
  });

  it("connected to StdioServerTransport", () => {
    expect(MockStdioServerTransport).toHaveBeenCalledTimes(1);
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// tools/list handler
// ═════════════════════════════════════════════════════════════════════════════

describe("tools/list handler", () => {
  it("returns request_human_input tool", async () => {
    const handler = capturedHandlers["tools/list"];
    expect(handler).toBeDefined();
    const result = (await handler({})) as { tools: Array<{ name: string }> };
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe("request_human_input");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// tools/call handler
// ═════════════════════════════════════════════════════════════════════════════

describe("tools/call handler", () => {
  async function callTool(name: string, args: Record<string, unknown>) {
    const handler = capturedHandlers["tools/call"];
    return handler({ params: { name, arguments: args } }) as Promise<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>;
  }

  it("returns error for unknown tool name", async () => {
    const result = await callTool("unknown_tool", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Unknown tool/i);
  });

  it("returns error when question is missing", async () => {
    const result = await callTool("request_human_input", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/question/i);
  });

  it("returns error when question is not a string", async () => {
    const result = await callTool("request_human_input", { question: 42 });
    expect(result.isError).toBe(true);
  });

  it("posts request and polls for answer successfully", async () => {
    mockFetch
      .mockResolvedValueOnce(makeOkResponse({ request_id: "test-id-123" }))
      .mockResolvedValueOnce(makeOkResponse({ answer: "yes, proceed" }));

    const result = await callTool("request_human_input", { question: "Should I continue?" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe("yes, proceed");
  });

  it("includes image_path in request when provided", async () => {
    mockFetch
      .mockResolvedValueOnce(makeOkResponse({ request_id: "img-id" }))
      .mockResolvedValueOnce(makeOkResponse({ answer: "looks good" }));

    await callTool("request_human_input", {
      question: "Check image",
      image_path: "/tmp/screenshot.png",
    });

    const postBody = JSON.parse(mockFetch.mock.calls[0][1].body as string) as Record<string, unknown>;
    expect(postBody.image_path).toBe("/tmp/screenshot.png");
  });

  it("returns error when service is not running (fetch throws)", async () => {
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await callTool("request_human_input", { question: "hello?" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Error/i);
  });

  it("handles non-ok response from POST /request", async () => {
    mockFetch.mockResolvedValueOnce(makeErrResponse(500, "internal error"));
    const result = await callTool("request_human_input", { question: "fail?" });
    expect(result.isError).toBe(true);
  });

  it("handles missing request_id in POST /request response", async () => {
    mockFetch.mockResolvedValueOnce(makeOkResponse({ something_else: "x" }));
    const result = await callTool("request_human_input", { question: "fail?" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/request_id/i);
  });

  it("retries when GET /response returns empty (server long-poll timeout)", async () => {
    mockFetch
      .mockResolvedValueOnce(makeOkResponse({ request_id: "retry-id" }))
      .mockResolvedValueOnce(makeOkResponse({}))
      .mockResolvedValueOnce(makeOkResponse({ answer: "eventually" }));

    const result = await callTool("request_human_input", { question: "Retry?" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe("eventually");
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("handles non-ok response from GET /response", async () => {
    mockFetch
      .mockResolvedValueOnce(makeOkResponse({ request_id: "bad-poll-id" }))
      .mockResolvedValueOnce(makeErrResponse(502, "Telegram error: send failed"));
    const result = await callTool("request_human_input", { question: "bad poll?" });
    expect(result.isError).toBe(true);
  });

  it("handles fetch throw during polling", async () => {
    mockFetch
      .mockResolvedValueOnce(makeOkResponse({ request_id: "throw-id" }))
      .mockRejectedValueOnce(new Error("network down"));
    const result = await callTool("request_human_input", { question: "network?" });
    expect(result.isError).toBe(true);
  });

  it("omits image_path when not a string", async () => {
    mockFetch
      .mockResolvedValueOnce(makeOkResponse({ request_id: "no-img-id" }))
      .mockResolvedValueOnce(makeOkResponse({ answer: "ok" }));

    await callTool("request_human_input", { question: "Q", image_path: 42 });
    const postBody = JSON.parse(mockFetch.mock.calls[0][1].body as string) as Record<string, unknown>;
    expect(postBody.image_path).toBeUndefined();
  });
});
