/**
 * Tests for service-core.ts — the extracted business logic of meatbag-service.
 *
 * Covers:
 *   - In-memory request store CRUD (Map operations, optional fields, waiters)
 *   - Send queue FIFO ordering and activeRequestId tracking
 *   - processQueue dispatcher (no-op guards, text/photo routing, context prefix,
 *     failure handling, missing-entry skip, re-entrancy safety)
 *   - HTTP API endpoints via a real test server (GET /health, POST /request,
 *     GET /response/:id)
 *   - Error scenarios: 400 validation, 404, 502 Telegram failure
 *   - Sequential queue behavior end-to-end
 *
 * The Telegram sender is injected as a vi.fn() mock — no real network calls.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import {
  createServiceState,
  processQueue,
  createHttpHandler,
  ServiceState,
  TelegramSender,
  RequestEntry,
} from "../service-core";

// ── Test helpers ──────────────────────────────────────────────────────────────

function mockTg(overrides: Partial<TelegramSender> = {}): TelegramSender {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendPhoto: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

async function withTestServer(
  state: ServiceState,
  tg: TelegramSender,
  options: { longPollTimeoutMs?: number } = {}
): Promise<{ port: number; close: () => Promise<void> }> {
  const handler = createHttpHandler(state, tg, options);
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    handler(req, res).catch(() => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    close: () => new Promise<void>((ok, fail) => server.close((e) => (e ? fail(e) : ok()))),
  };
}

async function getJson(port: number, path: string) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: await res.json(), headers: res.headers };
}

async function postJson(port: number, path: string, data: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  return { status: res.status, body: await res.json() };
}

/** Tiny async pause to let fire-and-forget processQueue calls settle */
const tick = (ms = 20) => new Promise<void>((r) => setTimeout(r, ms));

// ── createServiceState ────────────────────────────────────────────────────────

describe("createServiceState", () => {
  it("creates empty state", () => {
    const state = createServiceState();
    expect(state.requests.size).toBe(0);
    expect(state.sendQueue).toEqual([]);
    expect(state.activeRequestId).toBeNull();
  });

  it("each call returns an independent instance", () => {
    const s1 = createServiceState();
    const s2 = createServiceState();
    s1.sendQueue.push("a");
    expect(s2.sendQueue).toHaveLength(0);
  });
});

// ── Request store CRUD ────────────────────────────────────────────────────────

describe("Request store CRUD", () => {
  let state: ServiceState;
  beforeEach(() => { state = createServiceState(); });

  it("creates and retrieves an entry", () => {
    const entry: RequestEntry = { id: "req-1", question: "Q?", waiters: [] };
    state.requests.set("req-1", entry);
    expect(state.requests.get("req-1")).toBe(entry);
  });

  it("updates answer on an existing entry", () => {
    const entry: RequestEntry = { id: "req-1", question: "Q?", waiters: [] };
    state.requests.set("req-1", entry);
    entry.answer = "42";
    expect(state.requests.get("req-1")?.answer).toBe("42");
  });

  it("returns undefined for a missing entry", () => {
    expect(state.requests.get("nonexistent")).toBeUndefined();
  });

  it("deletes an entry", () => {
    state.requests.set("req-1", { id: "req-1", question: "Q?", waiters: [] });
    state.requests.delete("req-1");
    expect(state.requests.has("req-1")).toBe(false);
  });

  it("stores multiple independent entries", () => {
    for (let i = 0; i < 5; i++) {
      state.requests.set(`req-${i}`, { id: `req-${i}`, question: `Q${i}?`, waiters: [] });
    }
    expect(state.requests.size).toBe(5);
    for (let i = 0; i < 5; i++) {
      expect(state.requests.get(`req-${i}`)?.question).toBe(`Q${i}?`);
    }
  });

  it("stores optional image_path and context fields", () => {
    const entry: RequestEntry = {
      id: "req-1",
      question: "What is this?",
      image_path: "/tmp/img.png",
      context: "Production alert",
      waiters: [],
    };
    state.requests.set("req-1", entry);
    const stored = state.requests.get("req-1")!;
    expect(stored.image_path).toBe("/tmp/img.png");
    expect(stored.context).toBe("Production alert");
  });

  it("failReason field marks a failed entry", () => {
    const entry: RequestEntry = { id: "req-1", question: "Q?", waiters: [] };
    state.requests.set("req-1", entry);
    entry.failReason = "network error";
    expect(state.requests.get("req-1")?.failReason).toBe("network error");
  });

  it("waiter callbacks are stored and invoked with a string answer", () => {
    const entry: RequestEntry = { id: "req-1", question: "Q?", waiters: [] };
    state.requests.set("req-1", entry);
    const cb = vi.fn();
    entry.waiters.push(cb);
    entry.waiters[0]("hello");
    expect(cb).toHaveBeenCalledWith("hello");
  });

  it("waiter callbacks can receive null (failure signal)", () => {
    const entry: RequestEntry = { id: "req-1", question: "Q?", waiters: [] };
    state.requests.set("req-1", entry);
    const cb = vi.fn();
    entry.waiters.push(cb);
    entry.waiters[0](null);
    expect(cb).toHaveBeenCalledWith(null);
  });

  it("multiple waiters on one entry are all called", () => {
    const entry: RequestEntry = { id: "req-1", question: "Q?", waiters: [] };
    state.requests.set("req-1", entry);
    const cbs = [vi.fn(), vi.fn(), vi.fn()];
    for (const cb of cbs) entry.waiters.push(cb);
    for (const w of entry.waiters) w("yes");
    for (const cb of cbs) expect(cb).toHaveBeenCalledWith("yes");
  });
});

// ── Send queue operations ─────────────────────────────────────────────────────

describe("Send queue operations", () => {
  it("maintains FIFO order", () => {
    const state = createServiceState();
    state.sendQueue.push("req-1", "req-2", "req-3");
    expect(state.sendQueue.shift()).toBe("req-1");
    expect(state.sendQueue.shift()).toBe("req-2");
    expect(state.sendQueue.shift()).toBe("req-3");
    expect(state.sendQueue).toHaveLength(0);
  });

  it("activeRequestId starts null, can be set and cleared", () => {
    const state = createServiceState();
    expect(state.activeRequestId).toBeNull();
    state.activeRequestId = "req-1";
    expect(state.activeRequestId).toBe("req-1");
    state.activeRequestId = null;
    expect(state.activeRequestId).toBeNull();
  });
});

// ── processQueue ──────────────────────────────────────────────────────────────

describe("processQueue", () => {
  let state: ServiceState;
  beforeEach(() => { state = createServiceState(); });

  it("is a no-op when activeRequestId is already set", async () => {
    state.requests.set("req-1", { id: "req-1", question: "Q?", waiters: [] });
    state.sendQueue.push("req-1");
    state.activeRequestId = "other-req";
    const tg = mockTg();
    await processQueue(state, tg);
    expect(tg.sendMessage).not.toHaveBeenCalled();
    expect(state.sendQueue).toHaveLength(1);
    expect(state.activeRequestId).toBe("other-req");
  });

  it("is a no-op when sendQueue is empty", async () => {
    const tg = mockTg();
    await processQueue(state, tg);
    expect(state.activeRequestId).toBeNull();
    expect(tg.sendMessage).not.toHaveBeenCalled();
  });

  it("sends text message and sets activeRequestId", async () => {
    state.requests.set("req-1", { id: "req-1", question: "Hello?", waiters: [] });
    state.sendQueue.push("req-1");
    const tg = mockTg();
    await processQueue(state, tg);
    expect(tg.sendMessage).toHaveBeenCalledWith("Hello?");
    expect(state.activeRequestId).toBe("req-1");
    expect(state.sendQueue).toHaveLength(0);
  });

  it("prepends context to message text", async () => {
    state.requests.set("req-1", {
      id: "req-1",
      question: "What now?",
      context: "Background info",
      waiters: [],
    });
    state.sendQueue.push("req-1");
    const tg = mockTg();
    await processQueue(state, tg);
    expect(tg.sendMessage).toHaveBeenCalledWith("[Context: Background info]\n\nWhat now?");
  });

  it("routes to sendPhoto when image_path is set", async () => {
    state.requests.set("req-1", {
      id: "req-1",
      question: "What is this?",
      image_path: "/tmp/test.png",
      waiters: [],
    });
    state.sendQueue.push("req-1");
    const tg = mockTg();
    await processQueue(state, tg);
    expect(tg.sendPhoto).toHaveBeenCalledWith("/tmp/test.png", "What is this?");
    expect(tg.sendMessage).not.toHaveBeenCalled();
    expect(state.activeRequestId).toBe("req-1");
  });

  it("on failure: releases slot, sets failReason, notifies waiters with null", async () => {
    const entry: RequestEntry = { id: "req-1", question: "Q?", waiters: [] };
    state.requests.set("req-1", entry);
    state.sendQueue.push("req-1");
    const cb = vi.fn();
    entry.waiters.push(cb);
    const tg = mockTg({
      sendMessage: vi.fn().mockRejectedValue(new Error("Telegram 500")),
    });
    await processQueue(state, tg);
    expect(state.activeRequestId).toBeNull();
    expect(entry.failReason).toBe("Telegram 500");
    expect(cb).toHaveBeenCalledWith(null);
    expect(entry.waiters).toHaveLength(0);
  });

  it("on failure: processes next queued request", async () => {
    state.requests.set("req-1", { id: "req-1", question: "Fail?", waiters: [] });
    state.requests.set("req-2", { id: "req-2", question: "OK?", waiters: [] });
    state.sendQueue.push("req-1", "req-2");
    let callCount = 0;
    const tg = mockTg({
      sendMessage: vi.fn().mockImplementation(async (t: string) => {
        callCount++;
        if (t === "Fail?") throw new Error("fail");
      }),
    });
    await processQueue(state, tg);
    await tick();
    expect(state.activeRequestId).toBe("req-2");
    expect(tg.sendMessage).toHaveBeenCalledWith("OK?");
  });

  it("skips a missing entry and processes the next one", async () => {
    // req-1 is in queue but NOT in requests map
    state.requests.set("req-2", { id: "req-2", question: "Q2?", waiters: [] });
    state.sendQueue.push("req-1", "req-2");
    const tg = mockTg();
    await processQueue(state, tg);
    await tick();
    expect(tg.sendMessage).toHaveBeenCalledWith("Q2?");
    expect(state.activeRequestId).toBe("req-2");
  });

  it("sets activeRequestId before awaiting send (re-entrancy guard)", async () => {
    state.requests.set("req-1", { id: "req-1", question: "Q?", waiters: [] });
    state.sendQueue.push("req-1");
    let activeAtSendTime: string | null = "unset";
    const tg = mockTg({
      sendMessage: vi.fn().mockImplementation(async () => {
        activeAtSendTime = state.activeRequestId;
      }),
    });
    // Launch two concurrent calls; second should be a no-op
    await Promise.all([
      processQueue(state, tg),
      processQueue(state, tg),
    ]);
    expect(activeAtSendTime).toBe("req-1");
    expect(tg.sendMessage).toHaveBeenCalledOnce();
  });
});

// ── GET /health ───────────────────────────────────────────────────────────────

describe("GET /health", () => {
  it("returns ok with queued=0 and active=null when idle", async () => {
    const state = createServiceState();
    const { port, close } = await withTestServer(state, mockTg());
    try {
      const { status, body } = await getJson(port, "/health");
      expect(status).toBe(200);
      expect(body).toEqual({ status: "ok", queued: 0, active: null });
    } finally {
      await close();
    }
  });

  it("reflects the current send queue length", async () => {
    const state = createServiceState();
    state.sendQueue.push("req-1", "req-2");
    const { port, close } = await withTestServer(state, mockTg());
    try {
      const { body } = await getJson(port, "/health");
      expect((body as { queued: number }).queued).toBe(2);
    } finally {
      await close();
    }
  });

  it("reflects the active request ID", async () => {
    const state = createServiceState();
    state.activeRequestId = "req-abc";
    const { port, close } = await withTestServer(state, mockTg());
    try {
      const { body } = await getJson(port, "/health");
      expect((body as { active: string }).active).toBe("req-abc");
    } finally {
      await close();
    }
  });
});

// ── POST /request ─────────────────────────────────────────────────────────────

describe("POST /request", () => {
  it("returns 200 with a UUID request_id for a valid request", async () => {
    const state = createServiceState();
    const { port, close } = await withTestServer(state, mockTg());
    try {
      const { status, body } = await postJson(port, "/request", { question: "Test?" });
      expect(status).toBe(200);
      const id = (body as { request_id: string }).request_id;
      expect(typeof id).toBe("string");
      expect(id).toHaveLength(36); // UUID
    } finally {
      await close();
    }
  });

  it("stores the entry with correct question", async () => {
    const state = createServiceState();
    const { port, close } = await withTestServer(state, mockTg());
    try {
      const { body } = await postJson(port, "/request", { question: "My question" });
      const id = (body as { request_id: string }).request_id;
      expect(state.requests.get(id)?.question).toBe("My question");
    } finally {
      await close();
    }
  });

  it("stores image_path when provided", async () => {
    const state = createServiceState();
    const { port, close } = await withTestServer(state, mockTg());
    try {
      const { body } = await postJson(port, "/request", {
        question: "What?",
        image_path: "/tmp/screenshot.png",
      });
      const id = (body as { request_id: string }).request_id;
      expect(state.requests.get(id)?.image_path).toBe("/tmp/screenshot.png");
    } finally {
      await close();
    }
  });

  it("stores context when provided", async () => {
    const state = createServiceState();
    const { port, close } = await withTestServer(state, mockTg());
    try {
      const { body } = await postJson(port, "/request", {
        question: "Confirm?",
        context: "User is admin",
      });
      const id = (body as { request_id: string }).request_id;
      expect(state.requests.get(id)?.context).toBe("User is admin");
    } finally {
      await close();
    }
  });

  it("ignores non-string image_path", async () => {
    const state = createServiceState();
    const { port, close } = await withTestServer(state, mockTg());
    try {
      const { body } = await postJson(port, "/request", { question: "Q?", image_path: 42 });
      const id = (body as { request_id: string }).request_id;
      expect(state.requests.get(id)?.image_path).toBeUndefined();
    } finally {
      await close();
    }
  });

  it("returns 400 for invalid JSON body", async () => {
    const state = createServiceState();
    const { port, close } = await withTestServer(state, mockTg());
    try {
      const res = await fetch(`http://127.0.0.1:${port}/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json{{{",
      });
      const body = await res.json();
      expect(res.status).toBe(400);
      expect((body as { error: string }).error).toBe("invalid JSON body");
    } finally {
      await close();
    }
  });

  it("returns 400 when question is missing", async () => {
    const state = createServiceState();
    const { port, close } = await withTestServer(state, mockTg());
    try {
      const { status, body } = await postJson(port, "/request", { image_path: "/tmp/img" });
      expect(status).toBe(400);
      expect((body as { error: string }).error).toBe("question (string) is required");
    } finally {
      await close();
    }
  });

  it("returns 400 when question is empty string", async () => {
    const state = createServiceState();
    const { port, close } = await withTestServer(state, mockTg());
    try {
      const { status } = await postJson(port, "/request", { question: "" });
      expect(status).toBe(400);
    } finally {
      await close();
    }
  });

  it("returns 400 when question is not a string", async () => {
    const state = createServiceState();
    const { port, close } = await withTestServer(state, mockTg());
    try {
      const { status } = await postJson(port, "/request", { question: 42 });
      expect(status).toBe(400);
    } finally {
      await close();
    }
  });

  it("enqueues request ID in sendQueue", async () => {
    const state = createServiceState();
    state.activeRequestId = "blocker"; // prevent processQueue from consuming queue
    const { port, close } = await withTestServer(state, mockTg());
    try {
      const { body } = await postJson(port, "/request", { question: "Q?" });
      const id = (body as { request_id: string }).request_id;
      expect(state.sendQueue).toContain(id);
    } finally {
      await close();
    }
  });

  it("second request stays queued while first is active", async () => {
    const state = createServiceState();
    state.requests.set("first", { id: "first", question: "First?", waiters: [] });
    state.activeRequestId = "first";
    const { port, close } = await withTestServer(state, mockTg());
    try {
      const { body } = await postJson(port, "/request", { question: "Second?" });
      const id = (body as { request_id: string }).request_id;
      expect(state.sendQueue).toContain(id);
      expect(state.activeRequestId).toBe("first");
    } finally {
      await close();
    }
  });
});

// ── GET /response/:id ─────────────────────────────────────────────────────────

describe("GET /response/:id", () => {
  it("returns 404 for unknown request ID", async () => {
    const state = createServiceState();
    const { port, close } = await withTestServer(state, mockTg());
    try {
      const { status, body } = await getJson(port, "/response/nonexistent");
      expect(status).toBe(404);
      expect((body as { error: string }).error).toBe("request not found");
    } finally {
      await close();
    }
  });

  it("returns answer immediately if already answered", async () => {
    const state = createServiceState();
    state.requests.set("req-1", {
      id: "req-1",
      question: "Q?",
      answer: "The answer is 42",
      waiters: [],
    });
    const { port, close } = await withTestServer(state, mockTg());
    try {
      const { status, body } = await getJson(port, "/response/req-1");
      expect(status).toBe(200);
      expect(body).toEqual({ answer: "The answer is 42" });
    } finally {
      await close();
    }
  });

  it("returns 502 immediately if Telegram send already failed", async () => {
    const state = createServiceState();
    state.requests.set("req-1", {
      id: "req-1",
      question: "Q?",
      failReason: "connection refused",
      waiters: [],
    });
    const { port, close } = await withTestServer(state, mockTg());
    try {
      const { status, body } = await getJson(port, "/response/req-1");
      expect(status).toBe(502);
      expect((body as { error: string }).error).toContain("connection refused");
    } finally {
      await close();
    }
  });

  it("long-polls and returns answer when waiter is called", async () => {
    const state = createServiceState();
    const entry: RequestEntry = { id: "req-1", question: "Q?", waiters: [] };
    state.requests.set("req-1", entry);
    const { port, close } = await withTestServer(state, mockTg(), {
      longPollTimeoutMs: 5_000,
    });
    try {
      const pollPromise = getJson(port, "/response/req-1");
      await tick(50); // let server register the waiter
      expect(entry.waiters).toHaveLength(1);
      entry.waiters[0]("The answer is 42");
      const { status, body } = await pollPromise;
      expect(status).toBe(200);
      expect(body).toEqual({ answer: "The answer is 42" });
    } finally {
      await close();
    }
  });

  it("long-polls and returns 502 when waiter called with null", async () => {
    const state = createServiceState();
    const entry: RequestEntry = { id: "req-1", question: "Q?", waiters: [] };
    state.requests.set("req-1", entry);
    const { port, close } = await withTestServer(state, mockTg(), {
      longPollTimeoutMs: 5_000,
    });
    try {
      const pollPromise = getJson(port, "/response/req-1");
      await tick(50);
      entry.failReason = "Telegram API error";
      entry.waiters[0](null);
      const { status, body } = await pollPromise;
      expect(status).toBe(502);
      expect((body as { error: string }).error).toContain("Telegram API error");
    } finally {
      await close();
    }
  });

  it("long-poll times out and returns empty object", async () => {
    const state = createServiceState();
    state.requests.set("req-1", { id: "req-1", question: "Q?", waiters: [] });
    const { port, close } = await withTestServer(state, mockTg(), {
      longPollTimeoutMs: 60,
    });
    try {
      const { status, body } = await getJson(port, "/response/req-1");
      expect(status).toBe(200);
      expect(body).toEqual({});
    } finally {
      await close();
    }
  });

  it("removes waiter from entry after timeout", async () => {
    const state = createServiceState();
    const entry: RequestEntry = { id: "req-1", question: "Q?", waiters: [] };
    state.requests.set("req-1", entry);
    const { port, close } = await withTestServer(state, mockTg(), {
      longPollTimeoutMs: 60,
    });
    try {
      await getJson(port, "/response/req-1");
      expect(entry.waiters).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("multiple concurrent long-pollers all receive the same answer", async () => {
    const state = createServiceState();
    const entry: RequestEntry = { id: "req-1", question: "Q?", waiters: [] };
    state.requests.set("req-1", entry);
    const { port, close } = await withTestServer(state, mockTg(), {
      longPollTimeoutMs: 5_000,
    });
    try {
      const polls = [
        getJson(port, "/response/req-1"),
        getJson(port, "/response/req-1"),
        getJson(port, "/response/req-1"),
      ];
      await tick(60);
      expect(entry.waiters).toHaveLength(3);
      const waiters = [...entry.waiters];
      entry.waiters = [];
      for (const w of waiters) w("shared answer");
      const results = await Promise.all(polls);
      for (const { status, body } of results) {
        expect(status).toBe(200);
        expect(body).toEqual({ answer: "shared answer" });
      }
    } finally {
      await close();
    }
  });
});

// ── HTTP routing ──────────────────────────────────────────────────────────────

describe("HTTP routing", () => {
  it("returns 404 for unknown routes", async () => {
    const state = createServiceState();
    const { port, close } = await withTestServer(state, mockTg());
    try {
      const { status, body } = await getJson(port, "/unknown-route");
      expect(status).toBe(404);
      expect((body as { error: string }).error).toBe("not found");
    } finally {
      await close();
    }
  });

  it("GET /request (wrong method) returns 404", async () => {
    const state = createServiceState();
    const { port, close } = await withTestServer(state, mockTg());
    try {
      expect((await getJson(port, "/request")).status).toBe(404);
    } finally {
      await close();
    }
  });

  it("nested /response/foo/bar returns 404", async () => {
    const state = createServiceState();
    const { port, close } = await withTestServer(state, mockTg());
    try {
      expect((await getJson(port, "/response/foo/bar")).status).toBe(404);
    } finally {
      await close();
    }
  });

  it("responses have Content-Type: application/json", async () => {
    const state = createServiceState();
    const { port, close } = await withTestServer(state, mockTg());
    try {
      const { headers } = await getJson(port, "/health");
      expect(headers.get("content-type")).toBe("application/json");
    } finally {
      await close();
    }
  });
});

// ── Sequential queue behavior ─────────────────────────────────────────────────

describe("Sequential queue behavior", () => {
  it("first request is sent immediately, second stays queued", async () => {
    const state = createServiceState();
    const tg = mockTg();
    const { port, close } = await withTestServer(state, tg);
    try {
      const r1 = await postJson(port, "/request", { question: "First?" });
      await tick();
      const r2 = await postJson(port, "/request", { question: "Second?" });
      await tick();
      expect(tg.sendMessage).toHaveBeenCalledTimes(1);
      expect(tg.sendMessage).toHaveBeenCalledWith("First?");
      const id1 = (r1.body as { request_id: string }).request_id;
      const id2 = (r2.body as { request_id: string }).request_id;
      expect(state.activeRequestId).toBe(id1);
      expect(state.sendQueue).toContain(id2);
    } finally {
      await close();
    }
  });

  it("answering active request dispatches the next queued request", async () => {
    const state = createServiceState();
    const tg = mockTg();
    const { port, close } = await withTestServer(state, tg);
    try {
      const r1 = await postJson(port, "/request", { question: "First?" });
      await tick();
      const r2 = await postJson(port, "/request", { question: "Second?" });
      await tick();

      const id1 = (r1.body as { request_id: string }).request_id;
      const id2 = (r2.body as { request_id: string }).request_id;

      // Simulate pollLoop answering req-1
      const entry1 = state.requests.get(id1)!;
      state.activeRequestId = null;
      entry1.answer = "Done!";
      const waiters = [...entry1.waiters];
      entry1.waiters = [];
      for (const w of waiters) w("Done!");
      void processQueue(state, tg);

      await tick();

      expect(tg.sendMessage).toHaveBeenCalledTimes(2);
      expect(tg.sendMessage).toHaveBeenLastCalledWith("Second?");
      expect(state.activeRequestId).toBe(id2);
    } finally {
      await close();
    }
  });

  it("processQueue is a no-op while the active request is still sending", async () => {
    const state = createServiceState();
    let resolveBlock!: () => void;
    const blockSend = new Promise<void>((r) => { resolveBlock = r; });
    const tg = mockTg({
      sendMessage: vi.fn().mockReturnValue(blockSend),
    });
    state.requests.set("req-1", { id: "req-1", question: "Q1?", waiters: [] });
    state.requests.set("req-2", { id: "req-2", question: "Q2?", waiters: [] });
    state.sendQueue.push("req-1", "req-2");

    const pq1 = processQueue(state, tg);
    await tick(5);
    // While req-1 is still in-flight, a second call must not start req-2
    await processQueue(state, tg); // should return immediately (no-op)
    expect(state.sendQueue).toHaveLength(1); // req-2 still waiting

    resolveBlock();
    await pq1;
    expect(state.activeRequestId).toBe("req-1"); // slot stays after send
  });
});

// ── Error coverage: catch block + fallback branches ───────────────────────────
//
// These tests call the handler function directly (without withTestServer) so we
// can control the request stream and trigger the internal catch block.

import { EventEmitter } from "node:events";

function makeMockRes() {
  const res = {
    destroyed: false,
    writableEnded: false,
    _status: 0,
    _body: "",
    writeHead: vi.fn(function (this: typeof res, status: number) {
      this._status = status;
    }),
    end: vi.fn(function (this: typeof res, body: string) {
      this._body = body;
      this.writableEnded = true;
    }),
  };
  // bind `this` so the vi.fn() lambdas see the correct object
  res.writeHead = res.writeHead.bind(res) as typeof res.writeHead;
  res.end = res.end.bind(res) as typeof res.end;
  return res;
}

describe("createHttpHandler — internal catch block", () => {
  it("returns 500 when readBody throws an Error", async () => {
    const state = createServiceState();
    const handler = createHttpHandler(state, mockTg());

    const req = new EventEmitter() as any;
    req.method = "POST";
    req.url = "/request";

    const res = makeMockRes();
    const handlerPromise = handler(req, res as any);

    // Emit an Error on the request stream → readBody rejects
    process.nextTick(() => req.emit("error", new Error("socket hang up")));
    await handlerPromise;

    expect(res._status).toBe(500);
    expect(JSON.parse(res._body).error).toMatch(/socket hang up/);
  });

  it("returns 500 when readBody throws a non-Error value (covers String(err) branch)", async () => {
    const state = createServiceState();
    const handler = createHttpHandler(state, mockTg());

    const req = new EventEmitter() as any;
    req.method = "POST";
    req.url = "/request";

    const res = makeMockRes();
    const handlerPromise = handler(req, res as any);

    // Emit a non-Error to exercise the String(err) branch
    process.nextTick(() => req.emit("error", "raw string rejection"));
    await handlerPromise;

    expect(res._status).toBe(500);
    expect(JSON.parse(res._body).error).toBe("raw string rejection");
  });
});

describe("createHttpHandler — null waiter without failReason", () => {
  it("returns '502 Telegram error: send failed' when failReason is not set", async () => {
    const state = createServiceState();
    const entry: RequestEntry = { id: "req-1", question: "Q?", waiters: [] };
    state.requests.set("req-1", entry);
    const { port, close } = await withTestServer(state, mockTg(), {
      longPollTimeoutMs: 5_000,
    });
    try {
      const pollPromise = getJson(port, "/response/req-1");
      await tick(50);
      // Call waiter with null but intentionally leave failReason unset
      // so the fallback ?? "send failed" is used
      entry.waiters[0](null);
      const { status, body } = await pollPromise;
      expect(status).toBe(502);
      expect((body as { error: string }).error).toContain("send failed");
    } finally {
      await close();
    }
  });
});

describe("processQueue — non-Error Telegram failure", () => {
  it("sets failReason via String(err) when tg.sendMessage rejects with non-Error", async () => {
    const state = createServiceState();
    const entry: RequestEntry = { id: "req-1", question: "Q?", waiters: [] };
    state.requests.set("req-1", entry);
    state.sendQueue.push("req-1");

    const tg = mockTg({
      sendMessage: vi.fn().mockRejectedValue("raw rejection"),
    });
    await processQueue(state, tg);

    expect(entry.failReason).toBe("raw rejection");
    expect(state.activeRequestId).toBeNull();
  });
});
