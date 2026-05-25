/**
 * Tests for src/mcp.ts
 *
 * Strategy: mock global.fetch to simulate meatbag-service HTTP responses.
 * The MCP server construction is guarded by `require.main === module` so
 * importing this module does NOT spin up stdio connections.
 * The @modelcontextprotocol/sdk imports are mocked entirely to prevent
 * module resolution issues in the ts-jest CommonJS environment.
 */

// Mock the MCP SDK before any imports so the module guard doesn't spin up a server
jest.mock("@modelcontextprotocol/sdk/server/index", () => ({
  Server: jest.fn().mockImplementation(() => ({
    setRequestHandler: jest.fn(),
    connect: jest.fn(),
  })),
}));
jest.mock("@modelcontextprotocol/sdk/server/stdio", () => ({
  StdioServerTransport: jest.fn(),
}));
jest.mock("@modelcontextprotocol/sdk/types", () => ({
  CallToolRequestSchema: Symbol("CallToolRequestSchema"),
  ListToolsRequestSchema: Symbol("ListToolsRequestSchema"),
}));

import { postRequest, pollResponse, requestHumanInput, MAX_WAIT_MS } from "../mcp";

// ════════════════════════════════════════════════════════════════════════════
// postRequest
// ════════════════════════════════════════════════════════════════════════════

describe("postRequest", () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it("returns the request_id from a successful response", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ request_id: "abc-123" }),
    });
    const id = await postRequest("What time is it?");
    expect(id).toBe("abc-123");
  });

  it("posts to /request with the correct body", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ request_id: "id-1" }),
    });
    await postRequest("My question", "/tmp/image.png");
    const [url, opts] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/request");
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body as string);
    expect(body.question).toBe("My question");
    expect(body.image_path).toBe("/tmp/image.png");
  });

  it("omits image_path when not provided", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ request_id: "id-2" }),
    });
    await postRequest("Just a question");
    const body = JSON.parse(
      ((global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit])[1].body as string
    );
    expect(body.image_path).toBeUndefined();
  });

  it("throws a helpful error when the service is not reachable", async () => {
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(postRequest("q")).rejects.toThrow(/meatbag-service is not running.*ECONNREFUSED/s);
  });

  it("throws when the response is not ok", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: () => Promise.resolve("question is required"),
    });
    await expect(postRequest("q")).rejects.toThrow(/POST.*400/s);
  });

  it("throws when the response has no request_id", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ error: "missing field" }),
    });
    await expect(postRequest("q")).rejects.toThrow("Service returned no request_id");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// pollResponse
// ════════════════════════════════════════════════════════════════════════════

describe("pollResponse", () => {
  beforeEach(() => {
    global.fetch = jest.fn();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("returns the answer immediately when the first poll has it", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ answer: "the answer" }),
    });
    const result = await pollResponse("req-1");
    expect(result).toBe("the answer");
  });

  it("retries polling when the server returns an empty object, then resolves", async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}), // empty — no answer yet
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ answer: "delayed answer" }),
      });

    const promise = pollResponse("req-1");
    // Advance past POLL_INTERVAL_MS (2 s) to trigger the retry setTimeout
    await jest.advanceTimersByTimeAsync(2500);
    const result = await promise;
    expect(result).toBe("delayed answer");
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("throws when the response is not ok", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 502,
      text: () => Promise.resolve("Telegram error"),
    });
    await expect(pollResponse("req-1")).rejects.toThrow("502");
  });

  it("throws when fetch itself throws (network error)", async () => {
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error("Network failure"));
    await expect(pollResponse("req-1")).rejects.toThrow(
      `GET`
    );
  });

  it("throws a timeout error when the deadline is exceeded", async () => {
    // Make Date.now() return a value just past the deadline on the second call
    let calls = 0;
    jest.spyOn(Date, "now").mockImplementation(() => {
      // First call sets deadline, second call checks while condition
      return calls++ === 0 ? 0 : MAX_WAIT_MS + 1;
    });

    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });

    await expect(pollResponse("req-1")).rejects.toThrow("Timed out");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// requestHumanInput
// ════════════════════════════════════════════════════════════════════════════

describe("requestHumanInput", () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it("combines postRequest and pollResponse successfully", async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        // postRequest call
        ok: true,
        json: () => Promise.resolve({ request_id: "rid-42" }),
      })
      .mockResolvedValueOnce({
        // pollResponse call
        ok: true,
        json: () => Promise.resolve({ answer: "yes" }),
      });

    const result = await requestHumanInput("Approve?");
    expect(result).toBe("yes");
    // First fetch is POST /request, second is GET /response/:id
    expect(global.fetch).toHaveBeenCalledTimes(2);
    const pollUrl = ((global.fetch as jest.Mock).mock.calls[1] as [string])[0];
    expect(pollUrl).toContain("/response/rid-42");
  });

  it("propagates postRequest errors without calling pollResponse", async () => {
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(requestHumanInput("q")).rejects.toThrow("meatbag-service is not running");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("propagates pollResponse errors", async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ request_id: "rid-99" }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        text: () => Promise.resolve("Telegram down"),
      });

    await expect(requestHumanInput("q")).rejects.toThrow("502");
  });

  it("passes image_path through to postRequest", async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ request_id: "rid-img" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ answer: "looks good" }),
      });

    await requestHumanInput("What is in this image?", "/tmp/photo.jpg");
    const postBody = JSON.parse(
      ((global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit])[1].body as string
    );
    expect(postBody.image_path).toBe("/tmp/photo.jpg");
  });
});
