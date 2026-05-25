/**
 * Tests for meatbag-mcp — covers postRequest, pollResponse, requestHumanInput,
 * and the registered MCP request handlers.
 *
 * The @modelcontextprotocol/sdk is mocked so no real stdio transport is used.
 * mcp.ts exports its functions; main() is called at module level but the mock
 * ensures server.connect() resolves immediately without touching stdin/stdout.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Hoist shared state so it's available inside vi.mock factories ─────────────

type HandlerFn = (req: any) => Promise<any>;

const { registeredHandlers } = vi.hoisted(() => ({
  registeredHandlers: new Map<string, HandlerFn>(),
}));

// ── Mock MCP SDK before importing mcp.ts ─────────────────────────────────────

vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({
  Server: vi.fn().mockImplementation(() => ({
    setRequestHandler: vi.fn((schema: any, handler: HandlerFn) => {
      registeredHandlers.set(schema.method ?? JSON.stringify(schema), handler);
    }),
    connect: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("@modelcontextprotocol/sdk/types.js", () => ({
  ListToolsRequestSchema: { method: "tools/list" },
  CallToolRequestSchema: { method: "tools/call" },
}));

// ── Import after mocks are registered ────────────────────────────────────────

import {
  postRequest,
  pollResponse,
  requestHumanInput,
  main,
} from "../mcp";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeOkResponse(data: unknown): Response {
  return {
    ok: true,
    json: async () => data,
    text: async () => JSON.stringify(data),
  } as unknown as Response;
}

function makeErrResponse(status: number, body: string): Response {
  return {
    ok: false,
    status,
    text: async () => body,
  } as unknown as Response;
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ═══════════════════════════════════════════════════════════════════════════════
// postRequest
// ═══════════════════════════════════════════════════════════════════════════════

describe("postRequest", () => {
  it("returns request_id on success", async () => {
    fetchMock.mockResolvedValue(makeOkResponse({ request_id: "abc-123" }));
    const id = await postRequest("What is 2+2?");
    expect(id).toBe("abc-123");
  });

  it("includes image_path in the request body when provided", async () => {
    fetchMock.mockResolvedValue(makeOkResponse({ request_id: "abc-123" }));
    await postRequest("Q?", "/tmp/image.png");

    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string
    );
    expect(body.image_path).toBe("/tmp/image.png");
  });

  it("throws a helpful error when fetch rejects (service not running)", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(postRequest("Q?")).rejects.toThrow("meatbag-service is not running");
  });

  it("covers String(err) branch when fetch rejects with a non-Error value", async () => {
    fetchMock.mockRejectedValue("raw string rejection");
    await expect(postRequest("Q?")).rejects.toThrow("meatbag-service is not running");
  });

  it("throws when service returns non-ok status", async () => {
    fetchMock.mockResolvedValue(makeErrResponse(500, "Internal Server Error"));
    await expect(postRequest("Q?")).rejects.toThrow("POST");
  });

  it("throws when response has no request_id", async () => {
    fetchMock.mockResolvedValue(makeOkResponse({ error: "missing field" }));
    await expect(postRequest("Q?")).rejects.toThrow("no request_id");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// pollResponse
// ═══════════════════════════════════════════════════════════════════════════════

describe("pollResponse", () => {
  it("returns answer immediately when first response has it", async () => {
    fetchMock.mockResolvedValue(makeOkResponse({ answer: "42" }));
    const answer = await pollResponse("req-id");
    expect(answer).toBe("42");
  });

  it("retries on empty response until answer arrives", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(makeOkResponse({})) // first poll: no answer
      .mockResolvedValueOnce(makeOkResponse({ answer: "done" })); // second poll

    const promise = pollResponse("req-id");
    // Drain the first fetch
    await Promise.resolve();
    await Promise.resolve();
    // Advance POLL_INTERVAL_MS (2000ms)
    vi.advanceTimersByTime(2_000);
    await Promise.resolve();
    await Promise.resolve();

    const answer = await promise;
    expect(answer).toBe("done");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws when GET /response/:id fetch rejects — Error instance", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    await expect(pollResponse("req-id")).rejects.toThrow("network down");
  });

  it("covers String(err) branch when fetch rejects with non-Error value", async () => {
    fetchMock.mockRejectedValue(42);
    await expect(pollResponse("req-id")).rejects.toThrow("failed: 42");
  });

  it("throws when service returns non-ok status", async () => {
    fetchMock.mockResolvedValue(makeErrResponse(502, "Telegram error"));
    await expect(pollResponse("req-id")).rejects.toThrow("502");
  });

  it("throws timeout error when deadline elapses", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(makeOkResponse({}));

    const dateSpy = vi.spyOn(Date, "now");
    const realNow = Date.now();
    let callCount = 0;
    dateSpy.mockImplementation(() => {
      callCount++;
      // After 2 calls (deadline init + first loop check), jump past deadline
      if (callCount > 2) return realNow + 6 * 60 * 1000;
      return realNow;
    });

    const promise = pollResponse("req-id");
    await Promise.resolve();
    await Promise.resolve();
    vi.advanceTimersByTime(2_000);
    await Promise.resolve();
    await Promise.resolve();

    await expect(promise).rejects.toThrow("Timed out");
    dateSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// requestHumanInput
// ═══════════════════════════════════════════════════════════════════════════════

describe("requestHumanInput", () => {
  it("chains postRequest + pollResponse and returns final answer", async () => {
    fetchMock
      .mockResolvedValueOnce(makeOkResponse({ request_id: "req-123" }))
      .mockResolvedValueOnce(makeOkResponse({ answer: "human says yes" }));

    const answer = await requestHumanInput("Please confirm");
    expect(answer).toBe("human says yes");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// MCP request handlers
// ═══════════════════════════════════════════════════════════════════════════════

describe("MCP ListTools handler", () => {
  it("returns request_human_input tool with correct schema", async () => {
    const handler = registeredHandlers.get("tools/list");
    expect(handler).toBeDefined();

    const result = await handler!({});
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe("request_human_input");
    expect(result.tools[0].inputSchema.required).toContain("question");
  });
});

describe("MCP CallTool handler", () => {
  it("calls requestHumanInput and returns text content on success", async () => {
    fetchMock
      .mockResolvedValueOnce(makeOkResponse({ request_id: "r1" }))
      .mockResolvedValueOnce(makeOkResponse({ answer: "approved" }));

    const handler = registeredHandlers.get("tools/call");
    const result = await handler!({
      params: { name: "request_human_input", arguments: { question: "OK?" } },
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toBe("approved");
  });

  it("includes image_path in the request when provided", async () => {
    fetchMock
      .mockResolvedValueOnce(makeOkResponse({ request_id: "r1" }))
      .mockResolvedValueOnce(makeOkResponse({ answer: "ok" }));

    const handler = registeredHandlers.get("tools/call");
    await handler!({
      params: {
        name: "request_human_input",
        arguments: { question: "look at this", image_path: "/tmp/a.png" },
      },
    });

    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string
    );
    expect(body.image_path).toBe("/tmp/a.png");
  });

  it("ignores non-string image_path", async () => {
    fetchMock
      .mockResolvedValueOnce(makeOkResponse({ request_id: "r1" }))
      .mockResolvedValueOnce(makeOkResponse({ answer: "ok" }));

    const handler = registeredHandlers.get("tools/call");
    await handler!({
      params: {
        name: "request_human_input",
        arguments: { question: "Q?", image_path: 123 },
      },
    });

    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string
    );
    expect(body.image_path).toBeUndefined();
  });

  it("returns isError with message when question is missing", async () => {
    const handler = registeredHandlers.get("tools/call");
    const result = await handler!({
      params: { name: "request_human_input", arguments: {} },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/question/);
  });

  it("returns isError when question is not a string", async () => {
    const handler = registeredHandlers.get("tools/call");
    const result = await handler!({
      params: { name: "request_human_input", arguments: { question: 42 } },
    });

    expect(result.isError).toBe(true);
  });

  it("returns isError for an unknown tool name", async () => {
    const handler = registeredHandlers.get("tools/call");
    const result = await handler!({
      params: { name: "some_other_tool", arguments: {} },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Unknown tool/);
  });

  it("returns isError when requestHumanInput throws", async () => {
    fetchMock.mockRejectedValue(new Error("connection refused"));

    const handler = registeredHandlers.get("tools/call");
    const result = await handler!({
      params: { name: "request_human_input", arguments: { question: "Q?" } },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Error:/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// main()
// ═══════════════════════════════════════════════════════════════════════════════

describe("main", () => {
  it("connects the server and writes to stderr", async () => {
    await main();
    expect(process.stderr.write).toHaveBeenCalledWith(
      expect.stringContaining("meatbag-mcp")
    );
  });
});
