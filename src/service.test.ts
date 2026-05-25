/**
 * Tests for meatbag-service core logic:
 *   - In-memory request store (CRUD)
 *   - Send queue operations
 *   - processQueue dispatcher
 *   - HTTP API endpoints (GET /health, POST /request, GET /response/:id)
 *   - Error scenarios
 *   - Sequential queue behavior
 *
 * Uses Node.js built-in test runner (node:test) — no extra dependencies.
 * Telegram I/O is injected as a mock; no real network calls are made.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, IncomingMessage, ServerResponse } from "http";
import {
  createServiceState,
  processQueue,
  createHttpHandler,
  ServiceState,
  TelegramSender,
  RequestEntry,
} from "./service-core";

// ── Test helpers ──────────────────────────────────────────────────────────────

/** Returns a no-op TelegramSender with optional overrides */
function mockTg(overrides: Partial<TelegramSender> = {}): TelegramSender {
  return {
    sendMessage: async () => {},
    sendPhoto: async () => {},
    ...overrides,
  };
}

/** Start a test HTTP server, run fn(port), then close it. */
async function withTestServer(
  state: ServiceState,
  tg: TelegramSender,
  options: { longPollTimeoutMs?: number } = {}
): Promise<{ port: number; close: () => Promise<void> }> {
  const handler = createHttpHandler(state, tg, options);
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    handler(req, res).catch(() => {
      // errors handled inside handler; silence unhandled-rejection
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      ),
  };
}

async function getJson(
  port: number,
  path: string
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  const body = await res.json();
  return { status: res.status, body };
}

async function postJson(
  port: number,
  path: string,
  data: unknown
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  const body = await res.json();
  return { status: res.status, body };
}

/** Small async pause to let fire-and-forget processQueue calls settle */
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

// ── createServiceState ────────────────────────────────────────────────────────

describe("createServiceState", () => {
  test("creates empty state", () => {
    const state = createServiceState();
    assert.equal(state.requests.size, 0);
    assert.deepEqual(state.sendQueue, []);
    assert.equal(state.activeRequestId, null);
  });

  test("each call returns an independent instance", () => {
    const s1 = createServiceState();
    const s2 = createServiceState();
    s1.sendQueue.push("a");
    assert.equal(s2.sendQueue.length, 0);
  });
});

// ── Request store CRUD ────────────────────────────────────────────────────────

describe("Request store CRUD", () => {
  test("creates and retrieves an entry", () => {
    const state = createServiceState();
    const entry: RequestEntry = { id: "req-1", question: "Answer?", waiters: [] };
    state.requests.set("req-1", entry);
    assert.equal(state.requests.has("req-1"), true);
    assert.equal(state.requests.get("req-1"), entry);
  });

  test("updates an existing entry", () => {
    const state = createServiceState();
    const entry: RequestEntry = { id: "req-1", question: "Q?", waiters: [] };
    state.requests.set("req-1", entry);
    entry.answer = "42";
    assert.equal(state.requests.get("req-1")?.answer, "42");
  });

  test("returns undefined for a missing entry", () => {
    const state = createServiceState();
    assert.equal(state.requests.get("nonexistent"), undefined);
  });

  test("deletes an entry", () => {
    const state = createServiceState();
    state.requests.set("req-1", { id: "req-1", question: "Q?", waiters: [] });
    state.requests.delete("req-1");
    assert.equal(state.requests.has("req-1"), false);
  });

  test("stores multiple independent entries", () => {
    const state = createServiceState();
    for (let i = 0; i < 5; i++) {
      state.requests.set(`req-${i}`, { id: `req-${i}`, question: `Q${i}?`, waiters: [] });
    }
    assert.equal(state.requests.size, 5);
    for (let i = 0; i < 5; i++) {
      assert.equal(state.requests.get(`req-${i}`)?.question, `Q${i}?`);
    }
  });

  test("stores optional image_path and context fields", () => {
    const state = createServiceState();
    const entry: RequestEntry = {
      id: "req-1",
      question: "What is this?",
      image_path: "/tmp/img.png",
      context: "Production alert",
      waiters: [],
    };
    state.requests.set("req-1", entry);
    const stored = state.requests.get("req-1")!;
    assert.equal(stored.image_path, "/tmp/img.png");
    assert.equal(stored.context, "Production alert");
  });

  test("failReason field marks a failed entry", () => {
    const state = createServiceState();
    const entry: RequestEntry = { id: "req-1", question: "Q?", waiters: [] };
    state.requests.set("req-1", entry);
    entry.failReason = "network error";
    assert.equal(state.requests.get("req-1")?.failReason, "network error");
  });

  test("waiter callbacks are stored and invoked with a string answer", () => {
    const state = createServiceState();
    const entry: RequestEntry = { id: "req-1", question: "Q?", waiters: [] };
    state.requests.set("req-1", entry);
    let received: string | null = "unset";
    entry.waiters.push((a) => { received = a; });
    entry.waiters[0]("hello");
    assert.equal(received, "hello");
  });

  test("waiter callbacks can receive null (failure signal)", () => {
    const state = createServiceState();
    const entry: RequestEntry = { id: "req-1", question: "Q?", waiters: [] };
    state.requests.set("req-1", entry);
    let received: string | null = "unset";
    entry.waiters.push((a) => { received = a; });
    entry.waiters[0](null);
    assert.equal(received, null);
  });

  test("multiple waiters on one entry are all called", () => {
    const state = createServiceState();
    const entry: RequestEntry = { id: "req-1", question: "Q?", waiters: [] };
    state.requests.set("req-1", entry);
    const answers: Array<string | null> = [];
    entry.waiters.push((a) => answers.push(a));
    entry.waiters.push((a) => answers.push(a));
    entry.waiters.push((a) => answers.push(a));
    for (const w of entry.waiters) w("yes");
    assert.deepEqual(answers, ["yes", "yes", "yes"]);
  });
});

// ── Send queue operations ─────────────────────────────────────────────────────

describe("Send queue operations", () => {
  test("FIFO order", () => {
    const state = createServiceState();
    state.sendQueue.push("req-1", "req-2", "req-3");
    assert.equal(state.sendQueue.shift(), "req-1");
    assert.equal(state.sendQueue.shift(), "req-2");
    assert.equal(state.sendQueue.shift(), "req-3");
    assert.equal(state.sendQueue.length, 0);
  });

  test("activeRequestId starts null, can be set and cleared", () => {
    const state = createServiceState();
    assert.equal(state.activeRequestId, null);
    state.activeRequestId = "req-1";
    assert.equal(state.activeRequestId, "req-1");
    state.activeRequestId = null;
    assert.equal(state.activeRequestId, null);
  });
});

// ── processQueue ──────────────────────────────────────────────────────────────

describe("processQueue", () => {
  test("no-op when activeRequestId is set", async () => {
    const state = createServiceState();
    state.requests.set("req-1", { id: "req-1", question: "Q?", waiters: [] });
    state.sendQueue.push("req-1");
    state.activeRequestId = "other-req";
    let called = false;
    const tg = mockTg({ sendMessage: async () => { called = true; } });
    await processQueue(state, tg);
    assert.equal(called, false);
    assert.equal(state.sendQueue.length, 1);
    assert.equal(state.activeRequestId, "other-req");
  });

  test("no-op when sendQueue is empty", async () => {
    const state = createServiceState();
    await processQueue(state, mockTg());
    assert.equal(state.activeRequestId, null);
  });

  test("sends text message and sets activeRequestId", async () => {
    const state = createServiceState();
    state.requests.set("req-1", { id: "req-1", question: "Hello?", waiters: [] });
    state.sendQueue.push("req-1");
    let sentText = "";
    await processQueue(state, mockTg({ sendMessage: async (t) => { sentText = t; } }));
    assert.equal(sentText, "Hello?");
    assert.equal(state.activeRequestId, "req-1");
    assert.equal(state.sendQueue.length, 0);
  });

  test("prepends context to message text", async () => {
    const state = createServiceState();
    state.requests.set("req-1", {
      id: "req-1",
      question: "What now?",
      context: "Background info",
      waiters: [],
    });
    state.sendQueue.push("req-1");
    let sentText = "";
    await processQueue(state, mockTg({ sendMessage: async (t) => { sentText = t; } }));
    assert.equal(sentText, "[Context: Background info]\n\nWhat now?");
  });

  test("routes to sendPhoto when image_path is set", async () => {
    const state = createServiceState();
    state.requests.set("req-1", {
      id: "req-1",
      question: "What is this?",
      image_path: "/tmp/test.png",
      waiters: [],
    });
    state.sendQueue.push("req-1");
    let sentPath = "";
    let sentCaption = "";
    await processQueue(
      state,
      mockTg({
        sendPhoto: async (p, c) => { sentPath = p; sentCaption = c; },
      })
    );
    assert.equal(sentPath, "/tmp/test.png");
    assert.equal(sentCaption, "What is this?");
    assert.equal(state.activeRequestId, "req-1");
  });

  test("on Telegram failure: releases slot, sets failReason, notifies waiters with null", async () => {
    const state = createServiceState();
    const entry: RequestEntry = { id: "req-1", question: "Q?", waiters: [] };
    state.requests.set("req-1", entry);
    state.sendQueue.push("req-1");
    let gotNull = false;
    entry.waiters.push((a) => { gotNull = a === null; });
    await processQueue(
      state,
      mockTg({ sendMessage: async () => { throw new Error("Telegram API error"); } })
    );
    assert.equal(state.activeRequestId, null);
    assert.equal(entry.failReason, "Telegram API error");
    assert.equal(gotNull, true);
    assert.equal(entry.waiters.length, 0);
  });

  test("on Telegram failure: processes next queued request", async () => {
    const state = createServiceState();
    state.requests.set("req-1", { id: "req-1", question: "Fail?", waiters: [] });
    state.requests.set("req-2", { id: "req-2", question: "OK?", waiters: [] });
    state.sendQueue.push("req-1", "req-2");
    const sentTexts: string[] = [];
    await processQueue(
      state,
      mockTg({
        sendMessage: async (t) => {
          if (t === "Fail?") throw new Error("fail");
          sentTexts.push(t);
        },
      })
    );
    await tick(); // let async recursive processQueue run
    assert.equal(state.activeRequestId, "req-2");
    assert.deepEqual(sentTexts, ["OK?"]);
  });

  test("skips missing entry in queue and processes next", async () => {
    const state = createServiceState();
    // req-1 is in queue but NOT in requests map
    state.requests.set("req-2", { id: "req-2", question: "Q2?", waiters: [] });
    state.sendQueue.push("req-1", "req-2");
    let sentText = "";
    await processQueue(state, mockTg({ sendMessage: async (t) => { sentText = t; } }));
    await tick();
    assert.equal(sentText, "Q2?");
    assert.equal(state.activeRequestId, "req-2");
  });

  test("activeRequestId is set before await (re-entrancy guard)", async () => {
    const state = createServiceState();
    state.requests.set("req-1", { id: "req-1", question: "Q?", waiters: [] });
    state.sendQueue.push("req-1");
    let activeAtSendTime: string | null = "unset";
    // Run two concurrent processQueue calls
    await Promise.all([
      processQueue(
        state,
        mockTg({
          sendMessage: async () => {
            activeAtSendTime = state.activeRequestId;
          },
        })
      ),
      processQueue(state, mockTg()), // second call — should be no-op
    ]);
    assert.equal(activeAtSendTime, "req-1"); // set before sendMessage awaited
    assert.equal(state.sendQueue.length, 0);
  });
});

// ── GET /health ───────────────────────────────────────────────────────────────

describe("GET /health", () => {
  test("idle state returns queued=0, active=null", async () => {
    const state = createServiceState();
    const { port, close } = await withTestServer(state, mockTg());
    try {
      const { status, body } = await getJson(port, "/health");
      assert.equal(status, 200);
      assert.deepEqual(body, { status: "ok", queued: 0, active: null });
    } finally {
      await close();
    }
  });

  test("reflects non-empty send queue", async () => {
    const state = createServiceState();
    state.sendQueue.push("req-1", "req-2");
    const { port, close } = await withTestServer(state, mockTg());
    try {
      const { status, body } = await getJson(port, "/health");
      assert.equal(status, 200);
      assert.deepEqual(body, { status: "ok", queued: 2, active: null });
    } finally {
      await close();
    }
  });

  test("reflects active request ID", async () => {
    const state = createServiceState();
    state.activeRequestId = "req-abc";
    const { port, close } = await withTestServer(state, mockTg());
    try {
      const { status, body } = await getJson(port, "/health");
      assert.equal(status, 200);
      assert.deepEqual(body, { status: "ok", queued: 0, active: "req-abc" });
    } finally {
      await close();
    }
  });
});

// ── POST /request ─────────────────────────────────────────────────────────────

describe("POST /request", () => {
  test("valid request returns 200 with a UUID request_id", async () => {
    const state = createServiceState();
    const { port, close } = await withTestServer(state, mockTg());
    try {
      const { status, body } = await postJson(port, "/request", { question: "What is 2+2?" });
      assert.equal(status, 200);
      const id = (body as { request_id: string }).request_id;
      assert.equal(typeof id, "string");
      assert.equal(id.length, 36); // UUID format
    } finally {
      await close();
    }
  });

  test("stores entry in state with correct question", async () => {
    const state = createServiceState();
    const { port, close } = await withTestServer(state, mockTg());
    try {
      const { body } = await postJson(port, "/request", { question: "My question" });
      const id = (body as { request_id: string }).request_id;
      const entry = state.requests.get(id);
      assert.ok(entry, "entry should exist in state");
      assert.equal(entry!.question, "My question");
      assert.equal(entry!.id, id);
    } finally {
      await close();
    }
  });

  test("stores image_path when provided", async () => {
    const state = createServiceState();
    const { port, close } = await withTestServer(state, mockTg());
    try {
      const { body } = await postJson(port, "/request", {
        question: "What do you see?",
        image_path: "/tmp/screenshot.png",
      });
      const id = (body as { request_id: string }).request_id;
      assert.equal(state.requests.get(id)?.image_path, "/tmp/screenshot.png");
    } finally {
      await close();
    }
  });

  test("stores context when provided", async () => {
    const state = createServiceState();
    const { port, close } = await withTestServer(state, mockTg());
    try {
      const { body } = await postJson(port, "/request", {
        question: "Confirm?",
        context: "User is logged in",
      });
      const id = (body as { request_id: string }).request_id;
      assert.equal(state.requests.get(id)?.context, "User is logged in");
    } finally {
      await close();
    }
  });

  test("ignores non-string image_path", async () => {
    const state = createServiceState();
    const { port, close } = await withTestServer(state, mockTg());
    try {
      const { body } = await postJson(port, "/request", {
        question: "Q?",
        image_path: 42,
      });
      const id = (body as { request_id: string }).request_id;
      assert.equal(state.requests.get(id)?.image_path, undefined);
    } finally {
      await close();
    }
  });

  test("returns 400 for invalid JSON body", async () => {
    const state = createServiceState();
    const { port, close } = await withTestServer(state, mockTg());
    try {
      const res = await fetch(`http://127.0.0.1:${port}/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json{{{",
      });
      const body = (await res.json()) as { error: string };
      assert.equal(res.status, 400);
      assert.equal(body.error, "invalid JSON body");
    } finally {
      await close();
    }
  });

  test("returns 400 when question is missing", async () => {
    const state = createServiceState();
    const { port, close } = await withTestServer(state, mockTg());
    try {
      const { status, body } = await postJson(port, "/request", { image_path: "/tmp/img.png" });
      assert.equal(status, 400);
      assert.equal((body as { error: string }).error, "question (string) is required");
    } finally {
      await close();
    }
  });

  test("returns 400 when question is empty string", async () => {
    const state = createServiceState();
    const { port, close } = await withTestServer(state, mockTg());
    try {
      const { status, body } = await postJson(port, "/request", { question: "" });
      assert.equal(status, 400);
      assert.equal((body as { error: string }).error, "question (string) is required");
    } finally {
      await close();
    }
  });

  test("returns 400 when question is not a string", async () => {
    const state = createServiceState();
    const { port, close } = await withTestServer(state, mockTg());
    try {
      const { status, body } = await postJson(port, "/request", { question: 42 });
      assert.equal(status, 400);
      assert.equal((body as { error: string }).error, "question (string) is required");
    } finally {
      await close();
    }
  });

  test("enqueues request ID in sendQueue", async () => {
    const state = createServiceState();
    // Block processQueue so the ID stays in sendQueue
    state.activeRequestId = "blocker";
    const { port, close } = await withTestServer(state, mockTg());
    try {
      const { body } = await postJson(port, "/request", { question: "Q?" });
      const id = (body as { request_id: string }).request_id;
      assert.ok(state.sendQueue.includes(id), "request_id should be in sendQueue");
    } finally {
      await close();
    }
  });

  test("second request stays queued while first is active", async () => {
    const state = createServiceState();
    // Freeze a first request as active
    const e1: RequestEntry = { id: "first", question: "First?", waiters: [] };
    state.requests.set("first", e1);
    state.activeRequestId = "first";
    const { port, close } = await withTestServer(state, mockTg());
    try {
      const { body } = await postJson(port, "/request", { question: "Second?" });
      const id = (body as { request_id: string }).request_id;
      assert.equal(state.sendQueue[0], id);
      assert.equal(state.activeRequestId, "first"); // unchanged
    } finally {
      await close();
    }
  });
});

// ── GET /response/:id ─────────────────────────────────────────────────────────

describe("GET /response/:id", () => {
  test("returns 404 for unknown request ID", async () => {
    const state = createServiceState();
    const { port, close } = await withTestServer(state, mockTg());
    try {
      const { status, body } = await getJson(port, "/response/nonexistent-id");
      assert.equal(status, 404);
      assert.equal((body as { error: string }).error, "request not found");
    } finally {
      await close();
    }
  });

  test("returns 200 with answer immediately if already answered", async () => {
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
      assert.equal(status, 200);
      assert.deepEqual(body, { answer: "The answer is 42" });
    } finally {
      await close();
    }
  });

  test("returns 502 immediately if Telegram send already failed", async () => {
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
      assert.equal(status, 502);
      assert.equal(
        (body as { error: string }).error,
        "Telegram error: connection refused"
      );
    } finally {
      await close();
    }
  });

  test("long-polls and returns answer when waiter is called", async () => {
    const state = createServiceState();
    const entry: RequestEntry = { id: "req-1", question: "Q?", waiters: [] };
    state.requests.set("req-1", entry);
    const { port, close } = await withTestServer(state, mockTg(), {
      longPollTimeoutMs: 5_000,
    });
    try {
      const pollPromise = getJson(port, "/response/req-1");
      await tick(50); // let server register the waiter
      assert.equal(entry.waiters.length, 1);
      entry.waiters[0]("The answer is 42");
      const { status, body } = await pollPromise;
      assert.equal(status, 200);
      assert.deepEqual(body, { answer: "The answer is 42" });
    } finally {
      await close();
    }
  });

  test("long-polls and returns 502 when waiter called with null", async () => {
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
      assert.equal(status, 502);
      assert.equal(
        (body as { error: string }).error,
        "Telegram error: Telegram API error"
      );
    } finally {
      await close();
    }
  });

  test("long-poll times out and returns empty object", async () => {
    const state = createServiceState();
    state.requests.set("req-1", { id: "req-1", question: "Q?", waiters: [] });
    const { port, close } = await withTestServer(state, mockTg(), {
      longPollTimeoutMs: 60,
    });
    try {
      const { status, body } = await getJson(port, "/response/req-1");
      assert.equal(status, 200);
      assert.deepEqual(body, {});
    } finally {
      await close();
    }
  });

  test("waiter is removed from entry after timeout", async () => {
    const state = createServiceState();
    const entry: RequestEntry = { id: "req-1", question: "Q?", waiters: [] };
    state.requests.set("req-1", entry);
    const { port, close } = await withTestServer(state, mockTg(), {
      longPollTimeoutMs: 60,
    });
    try {
      await getJson(port, "/response/req-1");
      assert.equal(entry.waiters.length, 0);
    } finally {
      await close();
    }
  });

  test("multiple concurrent long-pollers all receive the same answer", async () => {
    const state = createServiceState();
    const entry: RequestEntry = { id: "req-1", question: "Q?", waiters: [] };
    state.requests.set("req-1", entry);
    const { port, close } = await withTestServer(state, mockTg(), {
      longPollTimeoutMs: 5_000,
    });
    try {
      const p1 = getJson(port, "/response/req-1");
      const p2 = getJson(port, "/response/req-1");
      const p3 = getJson(port, "/response/req-1");
      await tick(60); // wait for all three to register
      assert.equal(entry.waiters.length, 3);
      // Notify all waiters (simulating pollLoop behaviour)
      const waiters = [...entry.waiters];
      entry.waiters = [];
      for (const w of waiters) w("shared answer");
      const results = await Promise.all([p1, p2, p3]);
      for (const { status, body } of results) {
        assert.equal(status, 200);
        assert.deepEqual(body, { answer: "shared answer" });
      }
    } finally {
      await close();
    }
  });
});

// ── HTTP routing ──────────────────────────────────────────────────────────────

describe("HTTP routing", () => {
  test("unknown route returns 404", async () => {
    const state = createServiceState();
    const { port, close } = await withTestServer(state, mockTg());
    try {
      const { status, body } = await getJson(port, "/unknown-route");
      assert.equal(status, 404);
      assert.equal((body as { error: string }).error, "not found");
    } finally {
      await close();
    }
  });

  test("GET /request (wrong method) returns 404", async () => {
    const state = createServiceState();
    const { port, close } = await withTestServer(state, mockTg());
    try {
      const { status } = await getJson(port, "/request");
      assert.equal(status, 404);
    } finally {
      await close();
    }
  });

  test("nested /response/foo/bar returns 404", async () => {
    const state = createServiceState();
    const { port, close } = await withTestServer(state, mockTg());
    try {
      const { status } = await getJson(port, "/response/foo/bar");
      assert.equal(status, 404);
    } finally {
      await close();
    }
  });

  test("response has Content-Type: application/json", async () => {
    const state = createServiceState();
    const { port, close } = await withTestServer(state, mockTg());
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(res.headers.get("content-type"), "application/json");
    } finally {
      await close();
    }
  });
});

// ── Sequential queue behavior ─────────────────────────────────────────────────

describe("Sequential queue behavior", () => {
  test("first request is sent immediately, second stays queued", async () => {
    const state = createServiceState();
    const sentTexts: string[] = [];
    const tg = mockTg({ sendMessage: async (t) => { sentTexts.push(t); } });
    const { port, close } = await withTestServer(state, tg);
    try {
      const r1 = await postJson(port, "/request", { question: "First?" });
      await tick(); // let processQueue run for req-1
      const r2 = await postJson(port, "/request", { question: "Second?" });
      await tick();
      assert.equal(sentTexts.length, 1);
      assert.equal(sentTexts[0], "First?");
      assert.equal(state.activeRequestId, (r1.body as { request_id: string }).request_id);
      assert.ok(
        state.sendQueue.includes((r2.body as { request_id: string }).request_id),
        "second request should be in sendQueue"
      );
    } finally {
      await close();
    }
  });

  test("answering active request sends next queued request", async () => {
    const state = createServiceState();
    const sentTexts: string[] = [];
    const tg = mockTg({ sendMessage: async (t) => { sentTexts.push(t); } });
    const { port, close } = await withTestServer(state, tg);
    try {
      const r1 = await postJson(port, "/request", { question: "First?" });
      await tick();
      const r2 = await postJson(port, "/request", { question: "Second?" });
      await tick();

      const id1 = (r1.body as { request_id: string }).request_id;
      const id2 = (r2.body as { request_id: string }).request_id;

      // Simulate pollLoop receiving an answer for req-1
      const entry1 = state.requests.get(id1)!;
      state.activeRequestId = null;
      entry1.answer = "Done!";
      const waiters1 = [...entry1.waiters];
      entry1.waiters = [];
      for (const w of waiters1) w("Done!");
      void processQueue(state, tg);

      await tick();

      assert.equal(sentTexts.length, 2);
      assert.equal(sentTexts[1], "Second?");
      assert.equal(state.activeRequestId, id2);
    } finally {
      await close();
    }
  });

  test("processQueue is no-op when called while active request is sending", async () => {
    const state = createServiceState();
    let resolveBlock!: () => void;
    // sendMessage blocks until we release it, simulating a slow Telegram API
    const blockSend = new Promise<void>((r) => { resolveBlock = r; });
    const tg = mockTg({ sendMessage: async () => { await blockSend; } });

    state.requests.set("req-1", { id: "req-1", question: "Q1?", waiters: [] });
    state.requests.set("req-2", { id: "req-2", question: "Q2?", waiters: [] });
    state.sendQueue.push("req-1", "req-2");

    // Start first processQueue — it blocks inside sendMessage
    const pq1 = processQueue(state, tg);
    await tick(5);
    // At this point activeRequestId = "req-1"; second call should be no-op
    const pq2 = processQueue(state, tg); // should return immediately
    await pq2;
    assert.equal(state.sendQueue.length, 1); // req-2 still waiting

    resolveBlock(); // unblock the first send
    await pq1;
    assert.equal(state.activeRequestId, "req-1"); // slot stays claimed after send
  });
});
