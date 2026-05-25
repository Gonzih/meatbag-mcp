import { describe, test, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";
import { IncomingMessage, ServerResponse } from "http";
import {
  createServiceState,
  createProcessQueue,
  createHttpHandler,
  RequestEntry,
  TgSendFn,
} from "../service-core";

// ── Response mock ─────────────────────────────────────────────────────────────

function makeResponse() {
  const res = new EventEmitter() as any;
  res.destroyed = false;
  res.writableEnded = false;
  res._status = 0;
  res._body = "";
  res.writeHead = vi.fn((status: number) => {
    res._status = status;
  });
  res.end = vi.fn((body: string) => {
    res._body = body;
    res.writableEnded = true;
  });
  return res as ServerResponse & { _status: number; _body: string };
}

// ── Request mock ──────────────────────────────────────────────────────────────

function makeGetRequest(url: string): IncomingMessage {
  return { method: "GET", url, on: vi.fn() } as unknown as IncomingMessage;
}

function makePostRequest(url: string, body: string): IncomingMessage {
  const emitter = new EventEmitter() as IncomingMessage;
  emitter.method = "POST";
  emitter.url = url;
  setImmediate(() => {
    emitter.emit("data", body);
    emitter.emit("end");
  });
  return emitter;
}

// ── createServiceState ────────────────────────────────────────────────────────

describe("createServiceState", () => {
  test("returns empty requests map, queue, and null activeRequestId", () => {
    const state = createServiceState();
    expect(state.requests.size).toBe(0);
    expect(state.sendQueue).toEqual([]);
    expect(state.activeRequestId).toBeNull();
  });
});

// ── createProcessQueue ────────────────────────────────────────────────────────

describe("createProcessQueue", () => {
  function setup(tgSend?: TgSendFn) {
    const state = createServiceState();
    const log = vi.fn();
    const sender: TgSendFn = tgSend ?? vi.fn().mockResolvedValue(undefined);
    const processQueue = createProcessQueue(state, sender, log);
    return { state, log, sender, processQueue };
  }

  test("does nothing when queue is empty and no active request", async () => {
    const { processQueue, sender } = setup();
    await processQueue();
    expect(sender).not.toHaveBeenCalled();
  });

  test("does nothing when activeRequestId is already set", async () => {
    const { state, processQueue, sender } = setup();
    state.activeRequestId = "existing-id";
    const entry: RequestEntry = { id: "q1", question: "Q?", waiters: [] };
    state.requests.set("q1", entry);
    state.sendQueue.push("q1");

    await processQueue();
    expect(sender).not.toHaveBeenCalled();
    expect(state.sendQueue).toContain("q1");
  });

  test("sends the first queued request and sets activeRequestId", async () => {
    const { state, processQueue, sender } = setup();
    const entry: RequestEntry = { id: "r1", question: "Hello?", waiters: [] };
    state.requests.set("r1", entry);
    state.sendQueue.push("r1");

    await processQueue();

    expect(sender).toHaveBeenCalledWith(entry, "Hello?");
    expect(state.activeRequestId).toBe("r1");
    expect(state.sendQueue).toHaveLength(0);
  });

  test("includes context in the text passed to tgSend", async () => {
    const { state, processQueue, sender } = setup();
    const entry: RequestEntry = {
      id: "r2", question: "What?", context: "Background info", waiters: [],
    };
    state.requests.set("r2", entry);
    state.sendQueue.push("r2");

    await processQueue();

    expect(sender).toHaveBeenCalledWith(entry, "[Context: Background info]\n\nWhat?");
  });

  test("skips missing entries and tries next", async () => {
    const { state, processQueue, sender } = setup();
    state.sendQueue.push("ghost"); // not in requests
    const entry: RequestEntry = { id: "real", question: "Hi", waiters: [] };
    state.requests.set("real", entry);
    state.sendQueue.push("real");

    await processQueue();

    expect(sender).toHaveBeenCalledWith(entry, "Hi");
  });

  test("on TG send failure: releases slot, sets failReason, notifies waiters", async () => {
    const failSender = vi.fn().mockRejectedValue(new Error("Telegram down"));
    const { state, processQueue, log } = setup(failSender);

    const waiter = vi.fn();
    const entry: RequestEntry = { id: "fail-1", question: "Q?", waiters: [waiter] };
    state.requests.set("fail-1", entry);
    state.sendQueue.push("fail-1");

    await processQueue();

    expect(state.activeRequestId).toBeNull();
    expect(entry.failReason).toBe("Telegram down");
    expect(waiter).toHaveBeenCalledWith(null);
    expect(entry.waiters).toHaveLength(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Telegram send failed"));
  });

  test("on TG send failure: logs the request id", async () => {
    const failSender = vi.fn().mockRejectedValue(new Error("err"));
    const { state, processQueue, log } = setup(failSender);

    const entry: RequestEntry = { id: "fail-2", question: "Q", waiters: [] };
    state.requests.set("fail-2", entry);
    state.sendQueue.push("fail-2");

    await processQueue();

    expect(log).toHaveBeenCalledWith(expect.stringContaining("fail-2"));
  });

  test("on failure: processes next queued entry after releasing slot", async () => {
    let callCount = 0;
    const mixedSender = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error("first fails");
    });

    const { state, processQueue } = setup(mixedSender);

    const e1: RequestEntry = { id: "e1", question: "Q1", waiters: [] };
    const e2: RequestEntry = { id: "e2", question: "Q2", waiters: [] };
    state.requests.set("e1", e1);
    state.requests.set("e2", e2);
    state.sendQueue.push("e1", "e2");

    await processQueue();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(mixedSender).toHaveBeenCalledTimes(2);
    expect(state.activeRequestId).toBe("e2");
  });

  test("logs success message after sending", async () => {
    const { state, processQueue, log } = setup();
    const entry: RequestEntry = { id: "ok-1", question: "Go?", waiters: [] };
    state.requests.set("ok-1", entry);
    state.sendQueue.push("ok-1");

    await processQueue();

    expect(log).toHaveBeenCalledWith(expect.stringContaining("ok-1"));
  });
});

// ── createHttpHandler ─────────────────────────────────────────────────────────

describe("createHttpHandler", () => {
  function setup(longPollTimeoutMs = 50) {
    const state = createServiceState();
    const processQueue = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();
    const handler = createHttpHandler(state, processQueue, log, { longPollTimeoutMs });
    return { state, processQueue, log, handler };
  }

  // ── GET /health ─────────────────────────────────────────────────────────────

  describe("GET /health", () => {
    test("returns status ok with queued count and active", async () => {
      const { state, handler } = setup();
      state.sendQueue.push("q1");
      state.activeRequestId = "active-req";
      const req = makeGetRequest("/health");
      const res = makeResponse();

      await handler(req, res);

      expect(res._status).toBe(200);
      const body = JSON.parse(res._body);
      expect(body.status).toBe("ok");
      expect(body.queued).toBe(1);
      expect(body.active).toBe("active-req");
    });

    test("reports zero queued and null active when idle", async () => {
      const { handler } = setup();
      const req = makeGetRequest("/health");
      const res = makeResponse();

      await handler(req, res);

      const body = JSON.parse(res._body);
      expect(body.queued).toBe(0);
      expect(body.active).toBeNull();
    });
  });

  // ── POST /request ────────────────────────────────────────────────────────────

  describe("POST /request", () => {
    test("enqueues request and returns request_id", async () => {
      const { state, processQueue, handler } = setup();
      const req = makePostRequest(
        "/request",
        JSON.stringify({ question: "Am I alive?" })
      );
      const res = makeResponse();

      await handler(req, res);

      expect(res._status).toBe(200);
      const body = JSON.parse(res._body);
      expect(typeof body.request_id).toBe("string");
      expect(body.request_id.length).toBeGreaterThan(0);
      expect(state.requests.has(body.request_id)).toBe(true);
      expect(state.sendQueue).toContain(body.request_id);
      expect(processQueue).toHaveBeenCalled();
    });

    test("stores question, image_path, and context in the entry", async () => {
      const { state, handler } = setup();
      const payload = {
        question: "What?",
        image_path: "/tmp/img.png",
        context: "Background",
      };
      const req = makePostRequest("/request", JSON.stringify(payload));
      const res = makeResponse();

      await handler(req, res);

      const id = JSON.parse(res._body).request_id;
      const entry = state.requests.get(id)!;
      expect(entry.question).toBe("What?");
      expect(entry.image_path).toBe("/tmp/img.png");
      expect(entry.context).toBe("Background");
    });

    test("returns 400 for invalid JSON body", async () => {
      const { handler } = setup();
      const req = makePostRequest("/request", "not json");
      const res = makeResponse();

      await handler(req, res);

      expect(res._status).toBe(400);
      expect(JSON.parse(res._body).error).toMatch(/invalid JSON/i);
    });

    test("returns 400 when question is missing", async () => {
      const { handler } = setup();
      const req = makePostRequest("/request", JSON.stringify({ other: "field" }));
      const res = makeResponse();

      await handler(req, res);

      expect(res._status).toBe(400);
      expect(JSON.parse(res._body).error).toMatch(/question/i);
    });

    test("returns 400 when question is empty string", async () => {
      const { handler } = setup();
      const req = makePostRequest("/request", JSON.stringify({ question: "" }));
      const res = makeResponse();

      await handler(req, res);

      expect(res._status).toBe(400);
    });

    test("returns 400 when question is not a string", async () => {
      const { handler } = setup();
      const req = makePostRequest("/request", JSON.stringify({ question: 42 }));
      const res = makeResponse();

      await handler(req, res);

      expect(res._status).toBe(400);
    });

    test("ignores non-string image_path", async () => {
      const { state, handler } = setup();
      const req = makePostRequest(
        "/request",
        JSON.stringify({ question: "Q?", image_path: 123 })
      );
      const res = makeResponse();

      await handler(req, res);

      const id = JSON.parse(res._body).request_id;
      expect(state.requests.get(id)!.image_path).toBeUndefined();
    });
  });

  // ── GET /response/:id ────────────────────────────────────────────────────────

  describe("GET /response/:id", () => {
    test("returns 404 for unknown request id", async () => {
      const { handler } = setup();
      const req = makeGetRequest("/response/unknown-id");
      const res = makeResponse();

      await handler(req, res);

      expect(res._status).toBe(404);
      expect(JSON.parse(res._body).error).toMatch(/not found/i);
    });

    test("returns answer immediately if already set", async () => {
      const { state, handler } = setup();
      const entry: RequestEntry = {
        id: "done-1", question: "Q", answer: "The answer", waiters: [],
      };
      state.requests.set("done-1", entry);

      const req = makeGetRequest("/response/done-1");
      const res = makeResponse();

      await handler(req, res);

      expect(res._status).toBe(200);
      expect(JSON.parse(res._body).answer).toBe("The answer");
    });

    test("returns 502 immediately if failReason is set", async () => {
      const { state, handler } = setup();
      const entry: RequestEntry = {
        id: "fail-1", question: "Q", failReason: "Telegram down", waiters: [],
      };
      state.requests.set("fail-1", entry);

      const req = makeGetRequest("/response/fail-1");
      const res = makeResponse();

      await handler(req, res);

      expect(res._status).toBe(502);
      expect(JSON.parse(res._body).error).toMatch(/Telegram down/);
    });

    test("long-poll: returns answer when waiter is called", async () => {
      const { state, handler } = setup();
      const entry: RequestEntry = { id: "pending-1", question: "Q", waiters: [] };
      state.requests.set("pending-1", entry);

      const req = makeGetRequest("/response/pending-1");
      const res = makeResponse();

      const handlerPromise = handler(req, res);

      setImmediate(() => {
        entry.waiters[0]!("My answer");
      });

      await handlerPromise;

      expect(res._status).toBe(200);
      expect(JSON.parse(res._body).answer).toBe("My answer");
    });

    test("long-poll: returns 502 when waiter called with null", async () => {
      const { state, handler } = setup();
      // No failReason initially — handler must register a waiter first
      const entry: RequestEntry = { id: "pending-2", question: "Q", waiters: [] };
      state.requests.set("pending-2", entry);

      const req = makeGetRequest("/response/pending-2");
      const res = makeResponse();

      const handlerPromise = handler(req, res);

      setImmediate(() => {
        entry.failReason = "oops";
        entry.waiters[0]!(null);
      });

      await handlerPromise;

      expect(res._status).toBe(502);
      expect(JSON.parse(res._body).error).toMatch(/oops/);
    });

    test("long-poll: times out and returns empty body", async () => {
      vi.useFakeTimers();
      const { state, handler } = setup(100);
      const entry: RequestEntry = { id: "timeout-1", question: "Q", waiters: [] };
      state.requests.set("timeout-1", entry);

      const req = makeGetRequest("/response/timeout-1");
      const res = makeResponse();

      const handlerPromise = handler(req, res);

      vi.advanceTimersByTime(200);
      await handlerPromise;
      vi.useRealTimers();

      expect(res._status).toBe(200);
      expect(res._body).toBe("{}");
    });

    test("long-poll: removes handler from waiters on timeout", async () => {
      vi.useFakeTimers();
      const { state, handler } = setup(100);
      const entry: RequestEntry = { id: "clean-1", question: "Q", waiters: [] };
      state.requests.set("clean-1", entry);

      const req = makeGetRequest("/response/clean-1");
      const res = makeResponse();

      const handlerPromise = handler(req, res);

      vi.advanceTimersByTime(200);
      await handlerPromise;
      vi.useRealTimers();

      expect(entry.waiters).toHaveLength(0);
    });
  });

  // ── Unknown routes ────────────────────────────────────────────────────────────

  describe("unknown routes", () => {
    test("returns 404 for GET /unknown", async () => {
      const { handler } = setup();
      const req = makeGetRequest("/unknown");
      const res = makeResponse();

      await handler(req, res);

      expect(res._status).toBe(404);
      expect(JSON.parse(res._body).error).toMatch(/not found/i);
    });

    test("returns 404 for GET /", async () => {
      const { handler } = setup();
      const req = makeGetRequest("/");
      const res = makeResponse();

      await handler(req, res);

      expect(res._status).toBe(404);
    });

    test("returns 500 when request handler throws unexpectedly", async () => {
      const { state, handler, log } = setup();

      const badReq = {
        method: "GET",
        url: "/response/boom",
        on: vi.fn(),
      } as unknown as IncomingMessage;

      (state.requests as any).get = () => {
        throw new Error("Unexpected boom");
      };

      const res = makeResponse();
      await handler(badReq, res);

      expect(res._status).toBe(500);
      expect(JSON.parse(res._body).error).toMatch(/Unexpected boom/);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("Request handler error"));
    });
  });
});
