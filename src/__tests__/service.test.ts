/**
 * Tests for src/service.ts
 *
 * Strategy:
 * - Unit tests for Telegram helpers: mock global.fetch
 * - Unit tests for processQueue: mock global.fetch + manipulate _state directly
 * - Integration tests for HTTP endpoints: spin up a real server on port 0 (random),
 *   use Node's http module for test requests (avoids colliding with fetch mocks)
 */

import * as http from "http";
import * as net from "net";
import {
  tgSendMessage,
  tgSendPhoto,
  tgGetUpdates,
  processQueue,
  _state,
  _resetState,
  httpHandler,
  RequestEntry,
} from "../service";

// ── Mock fs/promises so tgSendPhoto doesn't hit the filesystem ──────────────

jest.mock("fs/promises", () => ({
  readFile: jest.fn(),
}));

import { readFile } from "fs/promises";
const mockReadFile = readFile as jest.Mock;

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Drain all pending microtasks (lets void-fired promises complete) */
async function flushMicrotasks(iterations = 10): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    await Promise.resolve();
  }
}

/** Make an HTTP request using Node's built-in http module (avoids fetch mocks) */
function nodeRequest(
  method: string,
  url: string,
  body?: string
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method,
      headers: body
        ? {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          }
        : {},
    };
    const req = http.request(options, (res) => {
      let raw = "";
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode!, data: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode!, data: raw });
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// ════════════════════════════════════════════════════════════════════════════
// tgSendMessage
// ════════════════════════════════════════════════════════════════════════════

describe("tgSendMessage", () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it("sends a POST to /sendMessage with the correct body", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true });
    await tgSendMessage("hello world");
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/sendMessage");
    expect(opts.method).toBe("POST");
    const parsedBody = JSON.parse(opts.body as string);
    expect(parsedBody.text).toBe("hello world");
  });

  it("throws an error when the response is not ok", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: () => Promise.resolve("Bad Request"),
    });
    await expect(tgSendMessage("test")).rejects.toThrow("sendMessage failed: 400");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// tgSendPhoto
// ════════════════════════════════════════════════════════════════════════════

describe("tgSendPhoto", () => {
  beforeEach(() => {
    global.fetch = jest.fn();
    mockReadFile.mockResolvedValue(Buffer.from("fake image data"));
  });

  it("reads the file and posts to /sendPhoto", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true });
    await tgSendPhoto("/tmp/photo.jpg", "my caption");
    expect(mockReadFile).toHaveBeenCalledWith("/tmp/photo.jpg");
    const [url] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/sendPhoto");
  });

  it.each([
    ["/img/photo.jpg", "image/jpeg"],
    ["/img/photo.jpeg", "image/jpeg"],
    ["/img/photo.png", "image/png"],
    ["/img/photo.gif", "image/gif"],
    ["/img/photo.webp", "image/webp"],
    ["/img/photo.bmp", "image/jpeg"], // unknown extension falls back to image/jpeg
  ])("uses correct MIME type for %s → %s", async (path, expectedMime) => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true });
    await tgSendPhoto(path, "caption");
    const [, opts] = (global.fetch as jest.Mock).mock.calls[0] as [string, { body: FormData }];
    const photoBlob = (opts.body as FormData).get("photo") as Blob;
    expect(photoBlob.type).toBe(expectedMime);
  });

  it("appends caption to the form", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true });
    await tgSendPhoto("/tmp/img.png", "test caption");
    const [, opts] = (global.fetch as jest.Mock).mock.calls[0] as [string, { body: FormData }];
    expect((opts.body as FormData).get("caption")).toBe("test caption");
  });

  it("throws when the response is not ok", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal Server Error"),
    });
    await expect(tgSendPhoto("/tmp/photo.jpg", "cap")).rejects.toThrow(
      "sendPhoto failed: 500"
    );
  });

  it("propagates readFile errors", async () => {
    mockReadFile.mockRejectedValueOnce(new Error("ENOENT: file not found"));
    await expect(tgSendPhoto("/nonexistent.jpg", "cap")).rejects.toThrow(
      "ENOENT: file not found"
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// tgGetUpdates
// ════════════════════════════════════════════════════════════════════════════

describe("tgGetUpdates", () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it("returns the result array from a successful response", async () => {
    const updates = [
      { update_id: 42, message: { message_id: 1, chat: { id: 123 }, text: "hi" } },
    ];
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true, result: updates }),
    });
    const result = await tgGetUpdates(0, 30);
    expect(result).toEqual(updates);
    const [url, opts] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/getUpdates");
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body as string);
    expect(body.offset).toBe(0);
    expect(body.timeout).toBe(30);
  });

  it("returns an empty array when result is missing from the response", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });
    const result = await tgGetUpdates(10, 5);
    expect(result).toEqual([]);
  });

  it("sends the correct offset and timeout", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true, result: [] }),
    });
    await tgGetUpdates(99, 15);
    const body = JSON.parse(
      ((global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit])[1].body as string
    );
    expect(body.offset).toBe(99);
    expect(body.timeout).toBe(15);
  });

  it("throws when the response is not ok", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: () => Promise.resolve("Unauthorized"),
    });
    await expect(tgGetUpdates(0, 30)).rejects.toThrow("getUpdates failed: 401");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// processQueue
// ════════════════════════════════════════════════════════════════════════════

describe("processQueue", () => {
  beforeEach(() => {
    _resetState();
    global.fetch = jest.fn();
  });

  it("does nothing when activeRequestId is already set (re-entrancy guard)", async () => {
    _state.activeRequestId = "existing-id";
    const entry: RequestEntry = { id: "new-id", question: "q", waiters: [] };
    _state.requests.set("new-id", entry);
    _state.sendQueue.push("new-id");

    await processQueue();

    expect(global.fetch).not.toHaveBeenCalled();
    expect(_state.activeRequestId).toBe("existing-id");
    expect(_state.sendQueue).toHaveLength(1); // still in queue
  });

  it("does nothing when the send queue is empty", async () => {
    await processQueue();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("claims activeRequestId BEFORE awaiting Telegram send", async () => {
    let activeIdDuringFetch: string | null = null;
    const entry: RequestEntry = { id: "req-1", question: "test?", waiters: [] };
    _state.requests.set("req-1", entry);
    _state.sendQueue.push("req-1");

    (global.fetch as jest.Mock).mockImplementationOnce(async () => {
      activeIdDuringFetch = _state.activeRequestId;
      return { ok: true };
    });

    await processQueue();

    expect(activeIdDuringFetch).toBe("req-1");
    expect(_state.activeRequestId).toBe("req-1");
  });

  it("sends a plain text message for a text-only request", async () => {
    const entry: RequestEntry = { id: "req-1", question: "What is 2+2?", waiters: [] };
    _state.requests.set("req-1", entry);
    _state.sendQueue.push("req-1");

    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true });

    await processQueue();

    expect(_state.activeRequestId).toBe("req-1");
    const [url, opts] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/sendMessage");
    const body = JSON.parse(opts.body as string);
    expect(body.text).toBe("What is 2+2?");
  });

  it("prepends context prefix to the message text", async () => {
    const entry: RequestEntry = {
      id: "req-1",
      question: "What should I do?",
      context: "Production outage",
      waiters: [],
    };
    _state.requests.set("req-1", entry);
    _state.sendQueue.push("req-1");

    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true });

    await processQueue();

    const body = JSON.parse(
      ((global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit])[1].body as string
    );
    expect(body.text).toBe("[Context: Production outage]\n\nWhat should I do?");
  });

  it("sends a photo when image_path is set", async () => {
    mockReadFile.mockResolvedValueOnce(Buffer.from("img data"));
    const entry: RequestEntry = {
      id: "req-1",
      question: "Describe this image",
      image_path: "/tmp/screenshot.jpg",
      waiters: [],
    };
    _state.requests.set("req-1", entry);
    _state.sendQueue.push("req-1");

    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true });

    await processQueue();

    expect(_state.activeRequestId).toBe("req-1");
    const [url] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/sendPhoto");
  });

  it("on Telegram failure: resets activeRequestId, sets failReason, notifies waiters with null", async () => {
    const waiter = jest.fn();
    const entry: RequestEntry = { id: "req-1", question: "help?", waiters: [waiter] };
    _state.requests.set("req-1", entry);
    _state.sendQueue.push("req-1");

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Telegram error"),
    });

    await processQueue();

    expect(_state.activeRequestId).toBeNull();
    expect(entry.failReason).toContain("sendMessage failed");
    expect(waiter).toHaveBeenCalledWith(null);
    expect(entry.waiters).toHaveLength(0);
  });

  it("after failure, processes the next queued request", async () => {
    const entry1: RequestEntry = { id: "req-1", question: "q1", waiters: [] };
    const entry2: RequestEntry = { id: "req-2", question: "q2", waiters: [] };
    _state.requests.set("req-1", entry1);
    _state.requests.set("req-2", entry2);
    _state.sendQueue.push("req-1");
    _state.sendQueue.push("req-2");

    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve("err"),
      })
      .mockResolvedValueOnce({ ok: true });

    await processQueue();
    // Let the recursive void processQueue() complete
    await flushMicrotasks();

    expect(_state.activeRequestId).toBe("req-2");
    expect(entry1.failReason).toBeDefined();
  });

  it("skips entries missing from the request map and processes the next", async () => {
    const entry2: RequestEntry = { id: "req-2", question: "q2", waiters: [] };
    _state.requests.set("req-2", entry2);
    // push a phantom ID that has no entry in requests
    _state.sendQueue.push("phantom-id");
    _state.sendQueue.push("req-2");

    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true });

    await processQueue();
    await flushMicrotasks();

    expect(_state.activeRequestId).toBe("req-2");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// HTTP integration — GET /health
// ════════════════════════════════════════════════════════════════════════════

describe("HTTP: GET /health", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer(httpHandler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as net.AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(() => server.close());

  beforeEach(() => {
    _resetState();
    global.fetch = jest.fn().mockResolvedValue({ ok: true });
  });

  it("returns status ok with queued=0 and active=null when idle", async () => {
    const { status, data } = await nodeRequest("GET", `${baseUrl}/health`);
    expect(status).toBe(200);
    expect(data).toMatchObject({ status: "ok", queued: 0, active: null });
  });

  it("reflects queue depth and active request id", async () => {
    _state.sendQueue.push("id-a");
    _state.sendQueue.push("id-b");
    _state.activeRequestId = "id-x";

    const { status, data } = await nodeRequest("GET", `${baseUrl}/health`);
    expect(status).toBe(200);
    expect(data).toMatchObject({ status: "ok", queued: 2, active: "id-x" });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// HTTP integration — POST /request
// ════════════════════════════════════════════════════════════════════════════

describe("HTTP: POST /request", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer(httpHandler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as net.AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(() => server.close());

  beforeEach(() => {
    _resetState();
    // Mock Telegram so processQueue() succeeds silently
    global.fetch = jest.fn().mockResolvedValue({ ok: true });
  });

  it("returns 200 with a request_id for a valid request", async () => {
    const { status, data } = await nodeRequest(
      "POST",
      `${baseUrl}/request`,
      JSON.stringify({ question: "Are you there?" })
    );
    expect(status).toBe(200);
    expect((data as { request_id: string }).request_id).toMatch(
      /^[0-9a-f-]{36}$/
    );
  });

  it("stores the entry and queues the id", async () => {
    await nodeRequest(
      "POST",
      `${baseUrl}/request`,
      JSON.stringify({ question: "Hello?" })
    );
    await flushMicrotasks();
    // At least one request was registered
    expect(_state.requests.size).toBeGreaterThan(0);
  });

  it("stores image_path and context when provided", async () => {
    const { data } = await nodeRequest(
      "POST",
      `${baseUrl}/request`,
      JSON.stringify({ question: "Look at this", image_path: "/tmp/img.png", context: "ctx" })
    );
    const id = (data as { request_id: string }).request_id;
    const entry = _state.requests.get(id);
    expect(entry?.image_path).toBe("/tmp/img.png");
    expect(entry?.context).toBe("ctx");
  });

  it("ignores non-string image_path and context fields", async () => {
    const { data } = await nodeRequest(
      "POST",
      `${baseUrl}/request`,
      JSON.stringify({ question: "q", image_path: 42, context: null })
    );
    const id = (data as { request_id: string }).request_id;
    const entry = _state.requests.get(id);
    expect(entry?.image_path).toBeUndefined();
    expect(entry?.context).toBeUndefined();
  });

  it("returns 400 for invalid JSON", async () => {
    const { status, data } = await nodeRequest(
      "POST",
      `${baseUrl}/request`,
      "not json {"
    );
    expect(status).toBe(400);
    expect((data as { error: string }).error).toContain("invalid JSON");
  });

  it("returns 400 when question is missing", async () => {
    const { status } = await nodeRequest(
      "POST",
      `${baseUrl}/request`,
      JSON.stringify({ image_path: "/tmp/x.png" })
    );
    expect(status).toBe(400);
  });

  it("returns 400 when question is an empty string", async () => {
    const { status } = await nodeRequest(
      "POST",
      `${baseUrl}/request`,
      JSON.stringify({ question: "" })
    );
    expect(status).toBe(400);
  });

  it("returns 400 when question is not a string", async () => {
    const { status } = await nodeRequest(
      "POST",
      `${baseUrl}/request`,
      JSON.stringify({ question: 123 })
    );
    expect(status).toBe(400);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// HTTP integration — GET /response/:id
// ════════════════════════════════════════════════════════════════════════════

describe("HTTP: GET /response/:id", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer(httpHandler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as net.AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(() => server.close());

  beforeEach(() => {
    _resetState();
    global.fetch = jest.fn().mockResolvedValue({ ok: true });
  });

  it("returns 404 for an unknown request id", async () => {
    const { status, data } = await nodeRequest(
      "GET",
      `${baseUrl}/response/no-such-id`
    );
    expect(status).toBe(404);
    expect((data as { error: string }).error).toContain("not found");
  });

  it("returns the answer immediately when already answered", async () => {
    const entry: RequestEntry = {
      id: "req-1",
      question: "q",
      answer: "42",
      waiters: [],
    };
    _state.requests.set("req-1", entry);

    const { status, data } = await nodeRequest(
      "GET",
      `${baseUrl}/response/req-1`
    );
    expect(status).toBe(200);
    expect((data as { answer: string }).answer).toBe("42");
  });

  it("returns 502 immediately when the entry has a failReason", async () => {
    const entry: RequestEntry = {
      id: "req-1",
      question: "q",
      failReason: "Telegram offline",
      waiters: [],
    };
    _state.requests.set("req-1", entry);

    const { status, data } = await nodeRequest(
      "GET",
      `${baseUrl}/response/req-1`
    );
    expect(status).toBe(502);
    expect((data as { error: string }).error).toContain("Telegram offline");
  });

  it("long-poll resolves with 200 when a waiter callback fires with an answer", async () => {
    const entry: RequestEntry = { id: "req-1", question: "q", waiters: [] };
    _state.requests.set("req-1", entry);

    // Start the long-poll request in parallel
    const responsePromise = nodeRequest("GET", `${baseUrl}/response/req-1`);

    // Give the server time to register the waiter
    await new Promise((r) => setTimeout(r, 50));

    // Simulate an answer arriving (as pollLoop would do)
    expect(entry.waiters).toHaveLength(1);
    entry.waiters[0]("the answer");

    const { status, data } = await responsePromise;
    expect(status).toBe(200);
    expect((data as { answer: string }).answer).toBe("the answer");
  });

  it("long-poll returns 502 when a waiter callback fires with null (Telegram failure)", async () => {
    const entry: RequestEntry = { id: "req-1", question: "q", waiters: [] };
    _state.requests.set("req-1", entry);

    const responsePromise = nodeRequest("GET", `${baseUrl}/response/req-1`);
    await new Promise((r) => setTimeout(r, 50));

    entry.failReason = "send failed";
    entry.waiters[0](null);

    const { status, data } = await responsePromise;
    expect(status).toBe(502);
    expect((data as { error: string }).error).toContain("send failed");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// HTTP integration — unknown routes
// ════════════════════════════════════════════════════════════════════════════

describe("HTTP: unknown routes", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer(httpHandler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as net.AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(() => server.close());

  it("returns 404 for an unrecognized path", async () => {
    const { status } = await nodeRequest("GET", `${baseUrl}/not-a-real-path`);
    expect(status).toBe(404);
  });

  it("returns 404 for a POST to an unrecognized path", async () => {
    const { status } = await nodeRequest(
      "POST",
      `${baseUrl}/unknown`,
      JSON.stringify({})
    );
    expect(status).toBe(404);
  });
});
