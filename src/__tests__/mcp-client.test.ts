import { describe, test, expect, vi, beforeEach } from "vitest";
import { postRequest, pollResponse, requestHumanInput } from "../mcp-client";

const SERVICE_URL = "http://localhost:7702";

// ── fetch mock setup ──────────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
});

function mockResponse(ok: boolean, body: unknown, status = ok ? 200 : 400): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok,
    status,
    text: () => Promise.resolve(text),
    json: () => Promise.resolve(typeof body === "string" ? JSON.parse(text) : body),
  } as unknown as Response;
}

// ── postRequest ───────────────────────────────────────────────────────────────

describe("postRequest", () => {
  test("returns request_id on success", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(true, { request_id: "abc-123" }));
    const id = await postRequest(SERVICE_URL, "Is this working?");
    expect(id).toBe("abc-123");
  });

  test("sends question and image_path in request body", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(true, { request_id: "x" }));
    await postRequest(SERVICE_URL, "My question", "/tmp/img.png");

    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${SERVICE_URL}/request`);
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body as string)).toEqual({
      question: "My question",
      image_path: "/tmp/img.png",
    });
  });

  test("omits image_path when not provided", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(true, { request_id: "y" }));
    await postRequest(SERVICE_URL, "No image");
    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.image_path).toBeUndefined();
  });

  test("throws helpful message when service is unreachable", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(postRequest(SERVICE_URL, "Q")).rejects.toThrow(
      "meatbag-service is not running on"
    );
  });

  test("throws on non-ok HTTP status", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(false, "Service Error", 500));
    await expect(postRequest(SERVICE_URL, "Q")).rejects.toThrow(
      `POST ${SERVICE_URL}/request failed (500)`
    );
  });

  test("throws when service returns no request_id", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(true, { error: "bad" }));
    await expect(postRequest(SERVICE_URL, "Q")).rejects.toThrow(
      "Service returned no request_id"
    );
  });

  test("includes non-Error rejection value in error message", async () => {
    mockFetch.mockRejectedValueOnce("connection dropped");
    await expect(postRequest(SERVICE_URL, "Q")).rejects.toThrow("connection dropped");
  });
});

// ── pollResponse ──────────────────────────────────────────────────────────────

describe("pollResponse", () => {
  test("returns answer immediately if present on first poll", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(true, { answer: "Yes!" }));
    const answer = await pollResponse(SERVICE_URL, "req-1", 60_000, 0);
    expect(answer).toBe("Yes!");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test("retries until answer appears", async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse(true, {}))
      .mockResolvedValueOnce(mockResponse(true, {}))
      .mockResolvedValueOnce(mockResponse(true, { answer: "Finally!" }));

    const result = await pollResponse(SERVICE_URL, "req-2", 60_000, 0);
    expect(result).toBe("Finally!");
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  test("throws on non-ok response status", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(false, "Telegram Error", 502));
    await expect(pollResponse(SERVICE_URL, "req-3", 60_000, 0)).rejects.toThrow(
      "GET /response/req-3 returned 502"
    );
  });

  test("throws when deadline is exceeded", async () => {
    // maxWaitMs=0 means deadline = Date.now() so the while condition is immediately false
    await expect(pollResponse(SERVICE_URL, "req-4", 0, 0)).rejects.toThrow(
      "Timed out waiting for human response"
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("throws on network error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("socket hang up"));
    await expect(pollResponse(SERVICE_URL, "req-5", 60_000, 0)).rejects.toThrow(
      `GET ${SERVICE_URL}/response/req-5 failed: socket hang up`
    );
  });

  test("uses correct URL for polling", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(true, { answer: "ok" }));
    await pollResponse(SERVICE_URL, "my-request-id", 60_000, 0);
    expect(mockFetch.mock.calls[0][0]).toBe(
      `${SERVICE_URL}/response/my-request-id`
    );
  });

  test("includes non-Error rejection value in error message", async () => {
    mockFetch.mockRejectedValueOnce(42);
    await expect(pollResponse(SERVICE_URL, "req-x", 60_000, 0)).rejects.toThrow("42");
  });

  test("includes error body text in rejection message on non-ok status", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(false, "Telegram error: gateway down", 502));
    await expect(pollResponse(SERVICE_URL, "req-6", 60_000, 0)).rejects.toThrow(
      "Telegram error: gateway down"
    );
  });
});

// ── requestHumanInput ─────────────────────────────────────────────────────────

describe("requestHumanInput", () => {
  test("posts question then polls and returns answer", async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse(true, { request_id: "abc" }))
      .mockResolvedValueOnce(mockResponse(true, { answer: "The answer" }));

    const result = await requestHumanInput(SERVICE_URL, "Your question?");
    expect(result).toBe("The answer");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test("passes image_path through to postRequest", async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse(true, { request_id: "xyz" }))
      .mockResolvedValueOnce(mockResponse(true, { answer: "seen it" }));

    await requestHumanInput(SERVICE_URL, "What is this?", "/tmp/img.jpg");
    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.image_path).toBe("/tmp/img.jpg");
  });

  test("throws if postRequest fails", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(
      requestHumanInput(SERVICE_URL, "Q")
    ).rejects.toThrow("meatbag-service is not running on");
  });

  test("throws if pollResponse fails", async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse(true, { request_id: "rid" }))
      .mockResolvedValueOnce(mockResponse(false, "Error", 502));

    await expect(
      requestHumanInput(SERVICE_URL, "Q")
    ).rejects.toThrow("returned 502");
  });
});
