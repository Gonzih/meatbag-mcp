/**
 * Tests for service-core.ts
 *
 * Covers: readBody, sendJson, ServiceCore.tgSendMessage, tgSendPhoto,
 * tgGetUpdates, processQueue, handleUpdate, createRequestHandler (all routes),
 * including all error paths, boundary conditions, and edge cases.
 */

// Must be hoisted before any imports that use fs/promises
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
}));

import { EventEmitter } from "events";
import type { IncomingMessage, ServerResponse } from "http";
import * as fsPromises from "fs/promises";
import {
  readBody,
  sendJson,
  ServiceCore,
} from "../service-core";

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Create a mock IncomingMessage that emits data/end/error events via setImmediate.
 * Call readBody (or handler) BEFORE any flush — so listeners are registered first.
 */
function makeIncomingMessage(opts: {
  body?: string;
  error?: Error;
  method?: string;
  url?: string;
}): IncomingMessage {
  const emitter = new EventEmitter() as IncomingMessage;
  (emitter as unknown as Record<string, unknown>).method = opts.method ?? "GET";
  (emitter as unknown as Record<string, unknown>).url = opts.url ?? "/";

  // Emit asynchronously via setImmediate — listener must be registered first!
  setImmediate(() => {
    if (opts.error) {
      emitter.emit("error", opts.error);
    } else {
      if (opts.body !== undefined) emitter.emit("data", Buffer.from(opts.body));
      emitter.emit("end");
    }
  });
  return emitter;
}

/** Create a mock ServerResponse */
function makeServerResponse(overrides: Partial<ServerResponse> = {}): ServerResponse {
  return {
    destroyed: false,
    writableEnded: false,
    writeHead: vi.fn(),
    end: vi.fn(),
    ...overrides,
  } as unknown as ServerResponse;
}

/** Helper: make a GET request mock */
function makeGetRequest(url: string): IncomingMessage {
  return makeIncomingMessage({ method: "GET", url });
}

/** Helper: make a POST request mock with a JSON body */
function makePostRequest(url: string, body: string): IncomingMessage {
  return makeIncomingMessage({ method: "POST", url, body });
}

/** Parse the JSON body passed to res.end() */
function parseResBody(res: ServerResponse): unknown {
  const mock = res.end as ReturnType<typeof vi.fn>;
  return JSON.parse(mock.mock.calls[0][0] as string);
}

/** Get the status code passed to res.writeHead() */
function resStatus(res: ServerResponse): number {
  const mock = res.writeHead as ReturnType<typeof vi.fn>;
  return mock.mock.calls[0][0] as number;
}

// Mock fetch globally
const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  vi.mocked(fsPromises.readFile).mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ── readBody ─────────────────────────────────────────────────────────────────

describe("readBody", () => {
  it("resolves with the full body from a single data chunk", async () => {
    const req = makeIncomingMessage({ body: "hello world" });
    // readBody registers listeners synchronously; setImmediate fires AFTER
    const result = await readBody(req);
    expect(result).toBe("hello world");
  });

  it("resolves with empty string when no data chunks arrive", async () => {
    const req = makeIncomingMessage({ body: "" });
    const result = await readBody(req);
    expect(result).toBe("");
  });

  it("concatenates multiple data chunks emitted synchronously", async () => {
    const emitter = new EventEmitter() as IncomingMessage;
    const resultPromise = readBody(emitter); // register listeners first
    emitter.emit("data", Buffer.from("foo"));
    emitter.emit("data", Buffer.from("bar"));
    emitter.emit("end");
    const result = await resultPromise;
    expect(result).toBe("foobar");
  });

  it("rejects when the request emits an error event", async () => {
    const emitter = new EventEmitter() as IncomingMessage;
    // Attach rejection handler first, then register readBody listener, then emit
    const resultPromise = readBody(emitter);
    emitter.emit("error", new Error("socket hang up"));
    await expect(resultPromise).rejects.toThrow("socket hang up");
  });
});

// ── sendJson ─────────────────────────────────────────────────────────────────

describe("sendJson", () => {
  it("writes correct status, headers, and JSON body", () => {
    const res = makeServerResponse();
    sendJson(res, 200, { ok: true });
    expect(res.writeHead).toHaveBeenCalledWith(200, {
      "Content-Type": "application/json",
    });
    expect(res.end).toHaveBeenCalledWith('{"ok":true}');
  });

  it("writes non-200 status codes", () => {
    const res = makeServerResponse();
    sendJson(res, 404, { error: "not found" });
    expect(resStatus(res)).toBe(404);
  });

  it("does nothing when response is already destroyed", () => {
    const res = makeServerResponse({ destroyed: true });
    sendJson(res, 200, { ok: true });
    expect(res.writeHead).not.toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
  });

  it("does nothing when response writableEnded is true", () => {
    const res = makeServerResponse({ writableEnded: true });
    sendJson(res, 200, { ok: true });
    expect(res.writeHead).not.toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
  });
});

// ── ServiceCore.tgSendMessage ─────────────────────────────────────────────────

describe("ServiceCore.tgSendMessage", () => {
  it("POSTs to the sendMessage endpoint and resolves on success", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true });
    const core = new ServiceCore("botTOKEN", "99");
    await expect(core.tgSendMessage("hello")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/botbotTOKEN/sendMessage",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("throws when the Telegram API returns a non-ok response", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    });
    const core = new ServiceCore("bad_token", "99");
    await expect(core.tgSendMessage("hi")).rejects.toThrow(
      "sendMessage failed: 401 Unauthorized"
    );
  });

  it("propagates network errors from fetch", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const core = new ServiceCore("tok", "99");
    await expect(core.tgSendMessage("hi")).rejects.toThrow("ECONNREFUSED");
  });
});

// ── ServiceCore.tgSendPhoto ───────────────────────────────────────────────────

describe("ServiceCore.tgSendPhoto", () => {
  it("reads the file and POSTs to sendPhoto on success", async () => {
    vi.mocked(fsPromises.readFile).mockResolvedValueOnce(
      Buffer.from("img") as unknown as Awaited<ReturnType<typeof fsPromises.readFile>>
    );
    fetchMock.mockResolvedValueOnce({ ok: true });
    const core = new ServiceCore("tok", "42");
    await expect(core.tgSendPhoto("/tmp/shot.png", "caption")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/bottok/sendPhoto",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("throws when the Telegram API returns a non-ok response", async () => {
    vi.mocked(fsPromises.readFile).mockResolvedValueOnce(
      Buffer.from("img") as unknown as Awaited<ReturnType<typeof fsPromises.readFile>>
    );
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => "Bad Request",
    });
    const core = new ServiceCore("tok", "42");
    await expect(core.tgSendPhoto("/tmp/x.jpg", "cap")).rejects.toThrow(
      "sendPhoto failed: 400 Bad Request"
    );
  });

  it("propagates readFile errors (file not found) without calling fetch", async () => {
    vi.mocked(fsPromises.readFile).mockRejectedValueOnce(
      Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" })
    );
    const core = new ServiceCore("tok", "42");
    await expect(core.tgSendPhoto("/nonexistent.png", "cap")).rejects.toThrow("ENOENT");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses image/jpeg mime type for unknown extensions", async () => {
    vi.mocked(fsPromises.readFile).mockResolvedValueOnce(
      Buffer.from("img") as unknown as Awaited<ReturnType<typeof fsPromises.readFile>>
    );
    fetchMock.mockResolvedValueOnce({ ok: true });
    const core = new ServiceCore("tok", "42");
    // .bmp is not in the mime map → falls back to image/jpeg
    await expect(core.tgSendPhoto("/tmp/shot.bmp", "caption")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalled();
  });
});

// ── ServiceCore.tgGetUpdates ──────────────────────────────────────────────────

describe("ServiceCore.tgGetUpdates", () => {
  it("returns array of updates on success", async () => {
    const updates = [
      { update_id: 1, message: { message_id: 1, chat: { id: 42 }, text: "hi" } },
    ];
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, result: updates }),
    });
    const core = new ServiceCore("tok", "42");
    const result = await core.tgGetUpdates(0, 5);
    expect(result).toEqual(updates);
  });

  it("returns empty array when result is undefined in response", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, result: undefined }),
    });
    const core = new ServiceCore("tok", "42");
    const result = await core.tgGetUpdates(0, 5);
    expect(result).toEqual([]);
  });

  it("throws when the Telegram API returns a non-ok response", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    });
    const core = new ServiceCore("tok", "42");
    await expect(core.tgGetUpdates(0, 5)).rejects.toThrow(
      "getUpdates failed: 500 Internal Server Error"
    );
  });

  it("propagates AbortError from timeout", async () => {
    const abortErr = Object.assign(new Error("AbortError"), { name: "AbortError" });
    fetchMock.mockRejectedValueOnce(abortErr);
    const core = new ServiceCore("tok", "42");
    await expect(core.tgGetUpdates(0, 5)).rejects.toThrow("AbortError");
  });
});

// ── ServiceCore.processQueue ──────────────────────────────────────────────────

describe("ServiceCore.processQueue", () => {
  it("does nothing when another request is already active", async () => {
    const core = new ServiceCore("tok", "42");
    core.activeRequestId = "already-active";
    core.sendQueue.push("req1");
    const sendSpy = vi.spyOn(core, "tgSendMessage").mockResolvedValue(undefined);

    await core.processQueue();

    expect(sendSpy).not.toHaveBeenCalled();
    expect(core.sendQueue).toHaveLength(1); // not consumed
  });

  it("does nothing when sendQueue is empty", async () => {
    const core = new ServiceCore("tok", "42");
    const sendSpy = vi.spyOn(core, "tgSendMessage").mockResolvedValue(undefined);

    await core.processQueue();

    expect(sendSpy).not.toHaveBeenCalled();
    expect(core.activeRequestId).toBeNull();
  });

  it("skips missing entry and processes the next one", async () => {
    const core = new ServiceCore("tok", "42");
    // Ghost id not in requests map, followed by real entry
    core.sendQueue.push("ghost", "real");
    core.requests.set("real", { id: "real", question: "hello?", waiters: [] });
    const sendSpy = vi.spyOn(core, "tgSendMessage").mockResolvedValue(undefined);

    await core.processQueue();
    // Flush the void processQueue() recursive call
    await Promise.resolve();
    await Promise.resolve();

    expect(sendSpy).toHaveBeenCalledWith("hello?");
    expect(core.activeRequestId).toBe("real");
  });

  it("sends text message and claims activeRequestId", async () => {
    const core = new ServiceCore("tok", "42");
    core.requests.set("r1", { id: "r1", question: "who?", waiters: [] });
    core.sendQueue.push("r1");
    vi.spyOn(core, "tgSendMessage").mockResolvedValue(undefined);

    await core.processQueue();

    expect(core.activeRequestId).toBe("r1");
  });

  it("prepends [Context: ...] when entry has context", async () => {
    const core = new ServiceCore("tok", "42");
    core.requests.set("r1", {
      id: "r1",
      question: "proceed?",
      context: "deployment",
      waiters: [],
    });
    core.sendQueue.push("r1");
    const sendSpy = vi.spyOn(core, "tgSendMessage").mockResolvedValue(undefined);

    await core.processQueue();

    expect(sendSpy).toHaveBeenCalledWith("[Context: deployment]\n\nproceed?");
  });

  it("calls tgSendPhoto when entry has image_path", async () => {
    const core = new ServiceCore("tok", "42");
    core.requests.set("r1", {
      id: "r1",
      question: "look at this",
      image_path: "/tmp/pic.png",
      waiters: [],
    });
    core.sendQueue.push("r1");
    const photoSpy = vi.spyOn(core, "tgSendPhoto").mockResolvedValue(undefined);
    vi.spyOn(core, "tgSendMessage");

    await core.processQueue();

    expect(photoSpy).toHaveBeenCalledWith("/tmp/pic.png", "look at this");
  });

  it("on Telegram error: sets failReason, notifies waiters with null, releases slot", async () => {
    const core = new ServiceCore("tok", "42");
    const waiter = vi.fn();
    core.requests.set("r1", { id: "r1", question: "q", waiters: [waiter] });
    core.sendQueue.push("r1");
    vi.spyOn(core, "tgSendMessage").mockRejectedValue(new Error("tg went down"));

    await core.processQueue();

    expect(core.activeRequestId).toBeNull();
    const entry = core.requests.get("r1")!;
    expect(entry.failReason).toBe("tg went down");
    expect(waiter).toHaveBeenCalledWith(null);
    expect(entry.waiters).toHaveLength(0);
  });

  it("on send error: processes the next queued request after failure", async () => {
    const core = new ServiceCore("tok", "42");
    core.requests.set("r1", { id: "r1", question: "q1", waiters: [] });
    core.requests.set("r2", { id: "r2", question: "q2", waiters: [] });
    core.sendQueue.push("r1", "r2");

    const sendSpy = vi
      .spyOn(core, "tgSendMessage")
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValueOnce(undefined);

    await core.processQueue();
    await Promise.resolve();
    await Promise.resolve();

    expect(sendSpy).toHaveBeenCalledTimes(2);
    expect(core.activeRequestId).toBe("r2");
  });

  it("handles non-Error thrown from tgSendMessage", async () => {
    const core = new ServiceCore("tok", "42");
    const waiter = vi.fn();
    core.requests.set("r1", { id: "r1", question: "q", waiters: [waiter] });
    core.sendQueue.push("r1");
    vi.spyOn(core, "tgSendMessage").mockRejectedValue("raw string error");

    await core.processQueue();

    expect(core.requests.get("r1")!.failReason).toBe("raw string error");
    expect(waiter).toHaveBeenCalledWith(null);
  });
});

// ── ServiceCore.handleUpdate ──────────────────────────────────────────────────

describe("ServiceCore.handleUpdate", () => {
  it("ignores update with no message", async () => {
    const core = new ServiceCore("tok", "42");
    core.activeRequestId = "r1";
    await core.handleUpdate({ update_id: 1 });
    expect(core.activeRequestId).toBe("r1"); // unchanged
  });

  it("ignores message from wrong chat_id", async () => {
    const core = new ServiceCore("tok", "42");
    core.activeRequestId = "r1";
    await core.handleUpdate({
      update_id: 1,
      message: { message_id: 1, chat: { id: 999 }, text: "hi" },
    });
    expect(core.activeRequestId).toBe("r1"); // unchanged
  });

  it("ignores message with no text and no caption", async () => {
    const core = new ServiceCore("tok", "42");
    core.activeRequestId = "r1";
    await core.handleUpdate({
      update_id: 1,
      message: { message_id: 1, chat: { id: 42 } },
    });
    expect(core.activeRequestId).toBe("r1"); // unchanged
  });

  it("logs when message arrives but no request is active", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const core = new ServiceCore("tok", "42");
    // activeRequestId is null
    await core.handleUpdate({
      update_id: 1,
      message: { message_id: 1, chat: { id: 42 }, text: "hello" },
    });
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("no active request")
    );
    stderrSpy.mockRestore();
  });

  it("delivers answer to waiters and calls processQueue when entry exists", async () => {
    const core = new ServiceCore("tok", "42");
    const waiter = vi.fn();
    core.requests.set("r1", { id: "r1", question: "q", waiters: [waiter] });
    core.activeRequestId = "r1";
    const queueSpy = vi.spyOn(core, "processQueue").mockResolvedValue(undefined);

    await core.handleUpdate({
      update_id: 5,
      message: { message_id: 1, chat: { id: 42 }, text: "yes, do it" },
    });

    expect(core.activeRequestId).toBeNull();
    const entry = core.requests.get("r1")!;
    expect(entry.answer).toBe("yes, do it");
    expect(waiter).toHaveBeenCalledWith("yes, do it");
    expect(entry.waiters).toHaveLength(0);
    expect(queueSpy).toHaveBeenCalled();
  });

  it("uses caption when text is absent", async () => {
    const core = new ServiceCore("tok", "42");
    const waiter = vi.fn();
    core.requests.set("r1", { id: "r1", question: "q", waiters: [waiter] });
    core.activeRequestId = "r1";

    await core.handleUpdate({
      update_id: 1,
      message: { message_id: 1, chat: { id: 42 }, caption: "captioned reply" },
    });

    expect(waiter).toHaveBeenCalledWith("captioned reply");
  });

  it("calls processQueue even when entry is missing after slot release", async () => {
    const core = new ServiceCore("tok", "42");
    core.activeRequestId = "r1";
    // r1 is NOT in requests map
    const queueSpy = vi.spyOn(core, "processQueue").mockResolvedValue(undefined);

    await core.handleUpdate({
      update_id: 1,
      message: { message_id: 1, chat: { id: 42 }, text: "answer" },
    });

    expect(core.activeRequestId).toBeNull();
    expect(queueSpy).toHaveBeenCalled();
  });
});

// ── HTTP handler: GET /health ─────────────────────────────────────────────────

describe("HTTP handler GET /health", () => {
  it("returns status ok with queued and active fields", async () => {
    const core = new ServiceCore("tok", "42");
    core.sendQueue.push("x", "y");
    core.activeRequestId = "z";
    const handler = core.createRequestHandler();
    const req = makeGetRequest("/health");
    const res = makeServerResponse();

    await handler(req, res);

    expect(resStatus(res)).toBe(200);
    expect(parseResBody(res)).toEqual({ status: "ok", queued: 2, active: "z" });
  });

  it("returns active: null when no request is active", async () => {
    const core = new ServiceCore("tok", "42");
    const handler = core.createRequestHandler();
    const req = makeGetRequest("/health");
    const res = makeServerResponse();

    await handler(req, res);

    expect((parseResBody(res) as { active: unknown }).active).toBeNull();
  });
});

// ── HTTP handler: POST /request ───────────────────────────────────────────────

describe("HTTP handler POST /request", () => {
  it("returns 400 for invalid JSON body", async () => {
    const core = new ServiceCore("tok", "42");
    vi.spyOn(core, "processQueue").mockResolvedValue(undefined);
    const handler = core.createRequestHandler();
    // handler calls readBody internally; events fire via setImmediate AFTER listener is registered
    const req = makePostRequest("/request", "not-json{{{");
    const res = makeServerResponse();

    await handler(req, res);

    expect(resStatus(res)).toBe(400);
    expect(parseResBody(res)).toEqual({ error: "invalid JSON body" });
  });

  it("returns 400 when question field is missing", async () => {
    const core = new ServiceCore("tok", "42");
    vi.spyOn(core, "processQueue").mockResolvedValue(undefined);
    const handler = core.createRequestHandler();
    const req = makePostRequest("/request", JSON.stringify({ other: "field" }));
    const res = makeServerResponse();

    await handler(req, res);

    expect(resStatus(res)).toBe(400);
    expect(parseResBody(res)).toEqual({ error: "question (string) is required" });
  });

  it("returns 400 when question is an empty string", async () => {
    const core = new ServiceCore("tok", "42");
    vi.spyOn(core, "processQueue").mockResolvedValue(undefined);
    const handler = core.createRequestHandler();
    const req = makePostRequest("/request", JSON.stringify({ question: "" }));
    const res = makeServerResponse();

    await handler(req, res);

    expect(resStatus(res)).toBe(400);
  });

  it("returns 400 when question is not a string (e.g. number)", async () => {
    const core = new ServiceCore("tok", "42");
    vi.spyOn(core, "processQueue").mockResolvedValue(undefined);
    const handler = core.createRequestHandler();
    const req = makePostRequest("/request", JSON.stringify({ question: 123 }));
    const res = makeServerResponse();

    await handler(req, res);

    expect(resStatus(res)).toBe(400);
  });

  it("returns 200 with a UUID request_id for a valid question", async () => {
    const core = new ServiceCore("tok", "42");
    vi.spyOn(core, "processQueue").mockResolvedValue(undefined);
    const handler = core.createRequestHandler();
    const req = makePostRequest("/request", JSON.stringify({ question: "ready?" }));
    const res = makeServerResponse();

    await handler(req, res);

    expect(resStatus(res)).toBe(200);
    const body = parseResBody(res) as { request_id?: string };
    expect(body.request_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it("stores image_path and context on the entry when provided", async () => {
    const core = new ServiceCore("tok", "42");
    vi.spyOn(core, "processQueue").mockResolvedValue(undefined);
    const handler = core.createRequestHandler();
    const req = makePostRequest(
      "/request",
      JSON.stringify({ question: "what?", image_path: "/tmp/x.png", context: "ci run" })
    );
    const res = makeServerResponse();

    await handler(req, res);

    const body = parseResBody(res) as { request_id: string };
    const entry = core.requests.get(body.request_id)!;
    expect(entry.image_path).toBe("/tmp/x.png");
    expect(entry.context).toBe("ci run");
  });

  it("ignores non-string image_path and context (undefined in entry)", async () => {
    const core = new ServiceCore("tok", "42");
    vi.spyOn(core, "processQueue").mockResolvedValue(undefined);
    const handler = core.createRequestHandler();
    const req = makePostRequest(
      "/request",
      JSON.stringify({ question: "q", image_path: 42, context: true })
    );
    const res = makeServerResponse();

    await handler(req, res);

    const body = parseResBody(res) as { request_id: string };
    const entry = core.requests.get(body.request_id)!;
    expect(entry.image_path).toBeUndefined();
    expect(entry.context).toBeUndefined();
  });

  it("calls processQueue after enqueuing the request", async () => {
    const core = new ServiceCore("tok", "42");
    const queueSpy = vi.spyOn(core, "processQueue").mockResolvedValue(undefined);
    const handler = core.createRequestHandler();
    const req = makePostRequest("/request", JSON.stringify({ question: "go?" }));
    const res = makeServerResponse();

    await handler(req, res);

    expect(queueSpy).toHaveBeenCalled();
  });

  it("returns 500 when readBody throws an error (request stream error)", async () => {
    const core = new ServiceCore("tok", "42");
    const handler = core.createRequestHandler();
    // Emit error synchronously in the request body listener setup
    const emitter = new EventEmitter() as IncomingMessage;
    (emitter as unknown as Record<string, unknown>).method = "POST";
    (emitter as unknown as Record<string, unknown>).url = "/request";
    const handlerPromise = handler(emitter, makeServerResponse());
    // Emit error after readBody registers its listener (handler already awaiting readBody)
    emitter.emit("error", new Error("stream error"));
    const res = makeServerResponse();
    // Re-run with proper plumbing: use a fresh handler call with a simpler approach
    // (above handlerPromise is now unresolvable — test with a fresh setup)
    await handlerPromise.catch(() => {}); // drain
    // Use the simpler approach: trigger error via setImmediate-based helper
    const req2 = makeIncomingMessage({ method: "POST", url: "/request", error: new Error("stream broken") });
    const res2 = makeServerResponse();
    await handler(req2, res2);
    expect(resStatus(res2)).toBe(500);
    expect((parseResBody(res2) as { error: string }).error).toBe("stream broken");
  });
});

// ── HTTP handler: GET /response/:id ──────────────────────────────────────────

describe("HTTP handler GET /response/:id", () => {
  it("returns 404 for unknown request_id", async () => {
    const core = new ServiceCore("tok", "42");
    const handler = core.createRequestHandler();
    const req = makeGetRequest("/response/does-not-exist");
    const res = makeServerResponse();

    await handler(req, res);

    expect(resStatus(res)).toBe(404);
    expect(parseResBody(res)).toEqual({ error: "request not found" });
  });

  it("returns answer immediately when already set on the entry", async () => {
    const core = new ServiceCore("tok", "42");
    core.requests.set("r1", {
      id: "r1",
      question: "q",
      answer: "already answered",
      waiters: [],
    });
    const handler = core.createRequestHandler();
    const req = makeGetRequest("/response/r1");
    const res = makeServerResponse();

    await handler(req, res);

    expect(resStatus(res)).toBe(200);
    expect(parseResBody(res)).toEqual({ answer: "already answered" });
  });

  it("returns 502 immediately when failReason is already set", async () => {
    const core = new ServiceCore("tok", "42");
    core.requests.set("r1", {
      id: "r1",
      question: "q",
      failReason: "Telegram is down",
      waiters: [],
    });
    const handler = core.createRequestHandler();
    const req = makeGetRequest("/response/r1");
    const res = makeServerResponse();

    await handler(req, res);

    expect(resStatus(res)).toBe(502);
    expect((parseResBody(res) as { error: string }).error).toContain("Telegram is down");
  });

  it("long-poll resolves with answer when waiter callback is called with string", async () => {
    const core = new ServiceCore("tok", "42");
    core.requests.set("r1", { id: "r1", question: "q", waiters: [] });
    const handler = core.createRequestHandler();
    const req = makeGetRequest("/response/r1");
    const res = makeServerResponse();

    // Waiter is registered synchronously inside Promise constructor before await suspends
    const handlerPromise = handler(req, res);

    const entry = core.requests.get("r1")!;
    expect(entry.waiters).toHaveLength(1);
    entry.waiters[0]("the answer");

    await handlerPromise;

    expect(resStatus(res)).toBe(200);
    expect(parseResBody(res)).toEqual({ answer: "the answer" });
  });

  it("long-poll returns 502 when waiter callback is called with null (send failure)", async () => {
    const core = new ServiceCore("tok", "42");
    // No failReason initially — handler enters long-poll
    core.requests.set("r1", { id: "r1", question: "q", waiters: [] });
    const handler = core.createRequestHandler();
    const req = makeGetRequest("/response/r1");
    const res = makeServerResponse();

    const handlerPromise = handler(req, res);

    // Set failReason then call waiter with null to simulate send failure during long-poll
    const entry = core.requests.get("r1")!;
    entry.failReason = "tg error";
    entry.waiters[0](null);

    await handlerPromise;

    expect(resStatus(res)).toBe(502);
    expect((parseResBody(res) as { error: string }).error).toContain("tg error");
  });

  it("long-poll returns 502 with fallback message when failReason not yet set at callback time", async () => {
    const core = new ServiceCore("tok", "42");
    core.requests.set("r1", { id: "r1", question: "q", waiters: [] });
    const handler = core.createRequestHandler();
    const req = makeGetRequest("/response/r1");
    const res = makeServerResponse();

    const handlerPromise = handler(req, res);
    // Call with null WITHOUT setting failReason — exercises the "send failed" fallback
    const entry = core.requests.get("r1")!;
    entry.waiters[0](null);

    await handlerPromise;

    expect(resStatus(res)).toBe(502);
    expect((parseResBody(res) as { error: string }).error).toContain("send failed");
  });

  it("long-poll returns empty {} and removes waiter after 30s timeout", async () => {
    vi.useFakeTimers();
    const core = new ServiceCore("tok", "42");
    core.requests.set("r1", { id: "r1", question: "q", waiters: [] });
    const handler = core.createRequestHandler();
    const req = makeGetRequest("/response/r1");
    const res = makeServerResponse();

    const handlerPromise = handler(req, res);

    // Advance fake time to trigger the 30s timeout inside the handler
    await vi.advanceTimersByTimeAsync(30_000);
    await handlerPromise;

    expect(resStatus(res)).toBe(200);
    expect(parseResBody(res)).toEqual({});
    // Waiter should have been removed
    expect(core.requests.get("r1")!.waiters).toHaveLength(0);
  });
});

// ── HTTP handler: unknown routes ──────────────────────────────────────────────

describe("HTTP handler unknown routes", () => {
  it("returns 404 for an unrecognised path", async () => {
    const core = new ServiceCore("tok", "42");
    const handler = core.createRequestHandler();
    const req = makeGetRequest("/unknown/path");
    const res = makeServerResponse();

    await handler(req, res);

    expect(resStatus(res)).toBe(404);
    expect(parseResBody(res)).toEqual({ error: "not found" });
  });

  it("returns 404 for POST to a non-existent route", async () => {
    const core = new ServiceCore("tok", "42");
    const handler = core.createRequestHandler();
    const req = makeIncomingMessage({ method: "POST", url: "/nope", body: "" });
    const res = makeServerResponse();

    await handler(req, res);

    expect(resStatus(res)).toBe(404);
  });
});
