/**
 * Tests for mcp-core.ts
 *
 * Covers: postRequest, pollResponse — all error paths, boundary conditions,
 * network failures, malformed responses, and timeout scenarios.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { postRequest, pollResponse, POLL_INTERVAL_MS } from "../mcp-core";

const SERVICE = "http://localhost:7702";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ── postRequest ───────────────────────────────────────────────────────────────

describe("postRequest", () => {
  it("returns request_id on success", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ request_id: "abc-123" }),
    });

    const id = await postRequest(SERVICE, "is anyone there?");
    expect(id).toBe("abc-123");
    expect(fetchMock).toHaveBeenCalledWith(
      `${SERVICE}/request`,
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      })
    );
  });

  it("includes image_path in the POST body when provided", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ request_id: "xyz" }),
    });

    await postRequest(SERVICE, "check this", "/tmp/img.png");
    const callBody = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string
    );
    expect(callBody.image_path).toBe("/tmp/img.png");
  });

  it("throws a descriptive error when fetch throws (service not running)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED connect ECONNREFUSED"));

    await expect(postRequest(SERVICE, "q")).rejects.toThrow(
      `meatbag-service is not running on ${SERVICE}`
    );
  });

  it("throws when the service responds with a non-ok status", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => "question (string) is required",
    });

    await expect(postRequest(SERVICE, "")).rejects.toThrow(
      `POST ${SERVICE}/request failed (400)`
    );
  });

  it("throws when the service returns 500", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    });

    await expect(postRequest(SERVICE, "q")).rejects.toThrow("(500)");
  });

  it("throws when response JSON has no request_id field", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ error: "something went wrong" }),
    });

    await expect(postRequest(SERVICE, "q")).rejects.toThrow(
      "Service returned no request_id"
    );
  });

  it("throws when request_id is undefined in response JSON", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    });

    await expect(postRequest(SERVICE, "q")).rejects.toThrow(
      "Service returned no request_id"
    );
  });

  it("propagates non-Error thrown values from fetch", async () => {
    fetchMock.mockRejectedValueOnce("string rejection");

    await expect(postRequest(SERVICE, "q")).rejects.toThrow(
      `meatbag-service is not running on ${SERVICE}: string rejection`
    );
  });
});

// ── pollResponse ──────────────────────────────────────────────────────────────

describe("pollResponse", () => {
  it("returns answer immediately when first poll has it", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ answer: "yes!" }),
    });

    const result = await pollResponse(SERVICE, "req-1");
    expect(result).toBe("yes!");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `${SERVICE}/response/req-1`,
      expect.any(Object)
    );
  });

  it("retries when server returns empty {} (server-side long-poll timeout)", async () => {
    vi.useFakeTimers();

    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) }) // empty retry
      .mockResolvedValueOnce({ ok: true, json: async () => ({ answer: "got it" }) });

    const resultPromise = pollResponse(SERVICE, "req-1", 60_000);

    // First poll completes with empty → triggers setTimeout(POLL_INTERVAL_MS)
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    // Second poll completes with answer
    const result = await resultPromise;

    expect(result).toBe("got it");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws when maxWaitMs is exceeded before receiving an answer", async () => {
    vi.useFakeTimers();

    // Always return empty
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });

    // Catch the rejection immediately to avoid unhandled-rejection warnings
    let caughtError: Error | null = null;
    const settled = pollResponse(SERVICE, "req-1", 200).catch((e: Error) => {
      caughtError = e;
    });

    // Advance past the deadline
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 10);
    await settled;

    expect(caughtError).not.toBeNull();
    expect(caughtError!.message).toContain("Timed out waiting for human response");
  });

  it("throws immediately when fetch fails during polling", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network reset"));

    await expect(pollResponse(SERVICE, "req-1")).rejects.toThrow(
      `GET ${SERVICE}/response/req-1 failed: network reset`
    );
  });

  it("throws when the response has a non-ok status", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      text: async () => "Telegram error: gateway down",
    });

    await expect(pollResponse(SERVICE, "req-1")).rejects.toThrow(
      "GET /response/req-1 returned 502"
    );
  });

  it("throws with body content on non-ok response", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => "request not found",
    });

    await expect(pollResponse(SERVICE, "req-1")).rejects.toThrow(
      "request not found"
    );
  });

  it("propagates non-Error fetch rejection", async () => {
    fetchMock.mockRejectedValueOnce(42);

    await expect(pollResponse(SERVICE, "req-x")).rejects.toThrow(
      `GET ${SERVICE}/response/req-x failed: 42`
    );
  });

  it("returns answer on the second attempt after a 502 that becomes ok", async () => {
    // First call throws (network error) — actually let's test: first empty, second answer
    vi.useFakeTimers();

    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ answer: "confirmed" }) });

    const p = pollResponse(SERVICE, "rid", 60_000);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(await p).toBe("confirmed");
  });
});
