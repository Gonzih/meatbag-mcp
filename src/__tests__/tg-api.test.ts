import { describe, test, expect, vi, beforeEach } from "vitest";
import { tgSendMessage, tgSendPhoto, tgGetUpdates } from "../tg-api";

const TG_API = "https://api.telegram.org/botTEST_TOKEN";
const CHAT_ID = "12345";

// ── fetch mock setup ──────────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
});

// Helper: build a mock Response
function mockResponse(ok: boolean, body: unknown, status = ok ? 200 : 400): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok,
    status,
    text: () => Promise.resolve(text),
    json: () => Promise.resolve(typeof body === "string" ? JSON.parse(body) : body),
  } as unknown as Response;
}

// ── tgSendMessage ─────────────────────────────────────────────────────────────

describe("tgSendMessage", () => {
  test("POSTs to /sendMessage with correct payload", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(true, "{}"));
    await tgSendMessage(TG_API, CHAT_ID, "Hello!");

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${TG_API}/sendMessage`);
    expect(opts.method).toBe("POST");
    expect(opts.headers).toMatchObject({ "Content-Type": "application/json" });
    const body = JSON.parse(opts.body as string);
    expect(body).toEqual({ chat_id: CHAT_ID, text: "Hello!" });
  });

  test("resolves without value on success", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(true, "{}"));
    await expect(tgSendMessage(TG_API, CHAT_ID, "Hi")).resolves.toBeUndefined();
  });

  test("throws when response is not ok", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(false, "Unauthorized", 401));
    await expect(tgSendMessage(TG_API, CHAT_ID, "Hi")).rejects.toThrow(
      "sendMessage failed: 401 Unauthorized"
    );
  });

  test("throws on network error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network failure"));
    await expect(tgSendMessage(TG_API, CHAT_ID, "Hi")).rejects.toThrow("network failure");
  });
});

// ── tgSendPhoto ───────────────────────────────────────────────────────────────

vi.mock("fs/promises", () => ({
  readFile: vi.fn().mockResolvedValue(Buffer.from("image-data")),
}));

describe("tgSendPhoto", () => {
  test("POSTs multipart form to /sendPhoto", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(true, "{}"));
    await tgSendPhoto(TG_API, CHAT_ID, "/tmp/photo.png", "Look at this");

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${TG_API}/sendPhoto`);
    expect(opts.method).toBe("POST");
    expect(opts.body).toBeInstanceOf(FormData);

    const form = opts.body as FormData;
    expect(form.get("chat_id")).toBe(CHAT_ID);
    expect(form.get("caption")).toBe("Look at this");
  });

  test("resolves without value on success", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(true, "{}"));
    await expect(
      tgSendPhoto(TG_API, CHAT_ID, "/tmp/img.jpg", "Caption")
    ).resolves.toBeUndefined();
  });

  test("throws when response is not ok", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(false, "Bad Request", 400));
    await expect(
      tgSendPhoto(TG_API, CHAT_ID, "/tmp/img.jpg", "Caption")
    ).rejects.toThrow("sendPhoto failed: 400 Bad Request");
  });

  test("uses jpeg mime for .jpg extension", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(true, "{}"));
    await tgSendPhoto(TG_API, CHAT_ID, "/tmp/photo.jpg", "caption");
    const form = mockFetch.mock.calls[0][1].body as FormData;
    const blob = form.get("photo") as File;
    expect(blob.type).toBe("image/jpeg");
  });

  test("uses png mime for .png extension", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(true, "{}"));
    await tgSendPhoto(TG_API, CHAT_ID, "/tmp/photo.png", "caption");
    const form = mockFetch.mock.calls[0][1].body as FormData;
    const blob = form.get("photo") as File;
    expect(blob.type).toBe("image/png");
  });
});

// ── tgGetUpdates ──────────────────────────────────────────────────────────────

describe("tgGetUpdates", () => {
  test("POSTs to /getUpdates with correct payload", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse(true, { ok: true, result: [] })
    );
    await tgGetUpdates(TG_API, 42, 30);

    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${TG_API}/getUpdates`);
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body as string);
    expect(body).toEqual({ offset: 42, timeout: 30, allowed_updates: ["message"] });
  });

  test("returns empty array when result is empty", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse(true, { ok: true, result: [] })
    );
    const updates = await tgGetUpdates(TG_API, 0, 30);
    expect(updates).toEqual([]);
  });

  test("returns update objects", async () => {
    const fakeUpdates = [
      { update_id: 100, message: { message_id: 1, chat: { id: 12345 }, text: "hi" } },
    ];
    mockFetch.mockResolvedValueOnce(
      mockResponse(true, { ok: true, result: fakeUpdates })
    );
    const updates = await tgGetUpdates(TG_API, 0, 30);
    expect(updates).toEqual(fakeUpdates);
  });

  test("handles missing result field (returns empty array)", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse(true, { ok: true })
    );
    const updates = await tgGetUpdates(TG_API, 0, 30);
    expect(updates).toEqual([]);
  });

  test("throws when response is not ok", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(false, "Forbidden", 403));
    await expect(tgGetUpdates(TG_API, 0, 30)).rejects.toThrow(
      "getUpdates failed: 403 Forbidden"
    );
  });

  test("sets AbortSignal timeout (signal is present on the request)", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse(true, { ok: true, result: [] })
    );
    await expect(tgGetUpdates(TG_API, 0, 10)).resolves.toEqual([]);
    const opts = mockFetch.mock.calls[0][1] as RequestInit;
    expect(opts.signal).toBeDefined();
  });
});
