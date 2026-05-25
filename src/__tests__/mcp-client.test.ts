/**
 * Tests for src/mcp-client.ts
 *
 * Strategy: mock global fetch to simulate meatbag-service HTTP responses.
 * mcp-client.ts contains only pure HTTP client logic with no SDK imports,
 * no process.exit, and no server startup — safe to import directly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  postRequest,
  pollResponse,
  requestHumanInput,
  MAX_WAIT_MS,
  POLL_INTERVAL_MS,
  SERVICE_URL,
} from "../mcp-client";

// ── Helpers ───────────────────────────────────────────────────────────────────

function mockFetchOk(body: unknown) {
  return vi.fn().mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } satisfies Partial<Response>);
}

function mockFetchError(status: number, text: string) {
  return vi.fn().mockResolvedValueOnce({
    ok: false,
    status,
    json: () => Promise.resolve({ error: text }),
    text: () => Promise.resolve(text),
  } satisfies Partial<Response>);
}

// ════════════════════════════════════════════════════════════════════════════
// Configuration
// ════════════════════════════════════════════════════════════════════════════

describe("configuration", () => {
  it("SERVICE_URL defaults to localhost:7702", () => {
    // In the test environment MEATBAG_SERVICE_URL is not set, so it uses default
    expect(SERVICE_URL).toBe("http://localhost:7702");
  });

  it("POLL_INTERVAL_MS is 2 seconds", () => {
    expect(POLL_INTERVAL_MS).toBe(2_000);
  });

  it("MAX_WAIT_MS is 5 minutes", () => {
    expect(MAX_WAIT_MS).toBe(5 * 60 * 1_000);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// postRequest
// ════════════════════════════════════════════════════════════════════════════

describe("postRequest", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetchOk({ request_id: "default-id" }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the request_id from a successful response", async () => {
    vi.stubGlobal("fetch", mockFetchOk({ request_id: "abc-123" }));
    const id = await postRequest("What time is it?");
    expect(id).toBe("abc-123");
  });

  it("sends POST to /request with the correct JSON body", async () => {
    const mockFetch = mockFetchOk({ request_id: "id-1" });
    vi.stubGlobal("fetch", mockFetch);
    await postRequest("My question", "/tmp/image.png");
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/request");
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body as string);
    expect(body.question).toBe("My question");
    expect(body.image_path).toBe("/tmp/image.png");
  });

  it("omits image_path field when not provided", async () => {
    const mockFetch = mockFetchOk({ request_id: "id-2" });
    vi.stubGlobal("fetch", mockFetch);
    await postRequest("Just a question");
    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string
    );
    expect(body.image_path).toBeUndefined();
  });

  it("throws a helpful error when the service is not reachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValueOnce(new Error("ECONNREFUSED"))
    );
    await expect(postRequest("q")).rejects.toThrow(
      /meatbag-service is not running.*ECONNREFUSED/s
    );
  });

  it("throws when the HTTP response is not ok (includes status code)", async () => {
    vi.stubGlobal("fetch", mockFetchError(400, "question is required"));
    await expect(postRequest("q")).rejects.toThrow(/POST.*400/s);
  });

  it("throws when the response body has no request_id", async () => {
    vi.stubGlobal("fetch", mockFetchOk({ error: "missing field" }));
    await expect(postRequest("q")).rejects.toThrow("Service returned no request_id");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// pollResponse
// ════════════════════════════════════════════════════════════════════════════

describe("pollResponse", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns the answer when it arrives on the first poll", async () => {
    vi.stubGlobal("fetch", mockFetchOk({ answer: "the answer" }));
    const result = await pollResponse("req-1");
    expect(result).toBe("the answer");
  });

  it("sends GET to /response/:id", async () => {
    const mockFetch = mockFetchOk({ answer: "yes" });
    vi.stubGlobal("fetch", mockFetch);
    await pollResponse("my-req-id");
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toContain("/response/my-req-id");
  });

  it("retries when server returns empty object, then resolves", async () => {
    vi.useFakeTimers();
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve("{}"),
      } satisfies Partial<Response>)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ answer: "delayed answer" }),
        text: () => Promise.resolve('{"answer":"delayed answer"}'),
      } satisfies Partial<Response>);
    vi.stubGlobal("fetch", mockFetch);

    const promise = pollResponse("req-1");
    // First poll returns {} — advances past POLL_INTERVAL_MS (2 s) to trigger retry
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 100);
    const result = await promise;
    expect(result).toBe("delayed answer");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("throws when the HTTP response is not ok (includes status code)", async () => {
    vi.stubGlobal("fetch", mockFetchError(502, "Telegram error"));
    await expect(pollResponse("req-1")).rejects.toThrow("502");
  });

  it("throws when fetch itself throws (e.g. network failure)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValueOnce(new Error("Network failure"))
    );
    await expect(pollResponse("req-1")).rejects.toThrow(/GET.*Network failure/s);
  });

  it("throws a timeout error once the deadline is exceeded", async () => {
    // First call sets deadline, second call (loop condition) is past it
    let callCount = 0;
    vi.spyOn(Date, "now").mockImplementation(() =>
      callCount++ === 0 ? 0 : MAX_WAIT_MS + 1
    );
    vi.stubGlobal("fetch", mockFetchOk({}));
    await expect(pollResponse("req-1")).rejects.toThrow("Timed out");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// requestHumanInput
// ════════════════════════════════════════════════════════════════════════════

describe("requestHumanInput", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("combines postRequest and pollResponse to return the answer", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ request_id: "rid-42" }),
        text: () => Promise.resolve(""),
      } satisfies Partial<Response>)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ answer: "yes" }),
        text: () => Promise.resolve(""),
      } satisfies Partial<Response>);
    vi.stubGlobal("fetch", mockFetch);

    const result = await requestHumanInput("Approve?");
    expect(result).toBe("yes");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // Second call polls /response/<id returned by first call>
    const pollUrl = (mockFetch.mock.calls[1] as [string])[0];
    expect(pollUrl).toContain("/response/rid-42");
  });

  it("propagates a postRequest error without calling pollResponse", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValueOnce(new Error("ECONNREFUSED"))
    );
    await expect(requestHumanInput("q")).rejects.toThrow(
      "meatbag-service is not running"
    );
    // Only one fetch call (the POST) — polling never started
    const mockFetch = (globalThis.fetch as ReturnType<typeof vi.fn>);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("propagates a pollResponse error", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ request_id: "rid-99" }),
        text: () => Promise.resolve(""),
      } satisfies Partial<Response>)
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        json: () => Promise.resolve({ error: "Telegram down" }),
        text: () => Promise.resolve("Telegram down"),
      } satisfies Partial<Response>);
    vi.stubGlobal("fetch", mockFetch);

    await expect(requestHumanInput("q")).rejects.toThrow("502");
  });

  it("passes image_path through to the POST request body", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ request_id: "rid-img" }),
        text: () => Promise.resolve(""),
      } satisfies Partial<Response>)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ answer: "looks good" }),
        text: () => Promise.resolve(""),
      } satisfies Partial<Response>);
    vi.stubGlobal("fetch", mockFetch);

    await requestHumanInput("Describe image", "/tmp/photo.jpg");
    const postBody = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string
    );
    expect(postBody.image_path).toBe("/tmp/photo.jpg");
  });
});
