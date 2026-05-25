/**
 * Unit tests for mcp.ts exported functions:
 *   postRequest, pollResponse, requestHumanInput
 *
 * Uses real timers throughout. Timeout tests use tiny maxWaitMs values (1–5ms)
 * so they complete quickly without fake-timer complexity.
 */

import { postRequest, pollResponse, requestHumanInput } from "./mcp";

// ── Mock fetch ────────────────────────────────────────────────────────────────

let mockFetch: jest.Mock;

beforeEach(() => {
  mockFetch = jest.fn();
  global.fetch = mockFetch as unknown as typeof fetch;
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ── postRequest ───────────────────────────────────────────────────────────────

describe("postRequest", () => {
  const serviceUrl = "http://localhost:7702";

  it("returns request_id on success", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ request_id: "abc-123" }),
    });

    const id = await postRequest("Hello?", undefined, serviceUrl);
    expect(id).toBe("abc-123");
  });

  it("POSTs to /request with question and image_path in body", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ request_id: "x" }),
    });

    await postRequest("question text", "/tmp/img.png", serviceUrl);

    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${serviceUrl}/request`);
    expect(options.method).toBe("POST");
    const body = JSON.parse(options.body as string) as {
      question: string;
      image_path: string;
    };
    expect(body.question).toBe("question text");
    expect(body.image_path).toBe("/tmp/img.png");
  });

  it("omits image_path from body when not provided", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ request_id: "y" }),
    });

    await postRequest("q only", undefined, serviceUrl);

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string) as { image_path?: string };
    expect(body.image_path).toBeUndefined();
  });

  it("throws descriptive error when fetch throws (service down)", async () => {
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(postRequest("q", undefined, serviceUrl)).rejects.toThrow(
      /meatbag-service is not running/
    );
  });

  it("throws when server returns non-ok status", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"error":"question is required"}',
    });

    await expect(postRequest("", undefined, serviceUrl)).rejects.toThrow(
      /POST.*failed \(400\)/
    );
  });

  it("throws when response has no request_id field", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ error: "something weird" }),
    });

    await expect(postRequest("q", undefined, serviceUrl)).rejects.toThrow(
      /no request_id/
    );
  });
});

// ── pollResponse ──────────────────────────────────────────────────────────────

describe("pollResponse", () => {
  const serviceUrl = "http://localhost:7702";
  const requestId = "req-abc";

  it("returns answer when first response contains it", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ answer: "Yes, I'm here!" }),
    });

    const answer = await pollResponse(requestId, serviceUrl, 5000, 0);
    expect(answer).toBe("Yes, I'm here!");
  });

  it("polls the correct URL", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ answer: "ok" }),
    });

    await pollResponse(requestId, serviceUrl, 5000, 0);

    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe(`${serviceUrl}/response/${requestId}`);
  });

  it("retries on empty response and returns answer on second call", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) }) // empty — no answer
      .mockResolvedValueOnce({ ok: true, json: async () => ({ answer: "Got it" }) });

    const answer = await pollResponse(requestId, serviceUrl, 5000, 1);
    expect(answer).toBe("Got it");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("throws when fetch throws (connection error)", async () => {
    mockFetch.mockRejectedValue(new Error("ECONNRESET"));

    await expect(pollResponse(requestId, serviceUrl, 5000, 0)).rejects.toThrow(/GET.*failed/);
  });

  it("throws when server returns non-ok status (502)", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => '{"error":"Telegram error: send failed"}',
    });

    await expect(pollResponse(requestId, serviceUrl, 5000, 0)).rejects.toThrow(/502/);
  });

  it("throws timeout error when deadline is exceeded", async () => {
    // Always return empty (no answer) — maxWaitMs=1 so expires after first iteration
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });

    // maxWaitMs=1ms, pollIntervalMs=0 — expires after at most one retry
    await expect(pollResponse(requestId, serviceUrl, 1, 0)).rejects.toThrow(
      /Timed out waiting for human response/
    );
  });
});

// ── requestHumanInput ─────────────────────────────────────────────────────────

describe("requestHumanInput", () => {
  const serviceUrl = "http://localhost:7702";

  it("returns the answer from a full round trip", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ request_id: "xyz" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ answer: "Human answer" }) });

    const answer = await requestHumanInput("Any updates?", undefined, serviceUrl);
    expect(answer).toBe("Human answer");
  });

  it("uses the returned request_id when polling", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ request_id: "my-id-42" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ answer: "ok" }) });

    await requestHumanInput("q", undefined, serviceUrl);

    const [pollUrl] = mockFetch.mock.calls[1] as [string];
    expect(pollUrl).toContain("my-id-42");
  });

  it("propagates postRequest error when service is down", async () => {
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(requestHumanInput("q", undefined, serviceUrl)).rejects.toThrow(
      /meatbag-service is not running/
    );
  });

  it("propagates pollResponse error (502)", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ request_id: "xyz" }) })
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        text: async () => '{"error":"Telegram error"}',
      });

    await expect(requestHumanInput("q", undefined, serviceUrl)).rejects.toThrow(/502/);
  });

  it("passes image_path to POST /request body", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ request_id: "xyz" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ answer: "Seen it" }) });

    await requestHumanInput("Look at this", "/tmp/screenshot.png", serviceUrl);

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string) as { image_path: string };
    expect(body.image_path).toBe("/tmp/screenshot.png");
  });
});
