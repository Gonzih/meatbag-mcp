/**
 * Integration tests for meatbag-service HTTP API.
 *
 * Each test suite creates a fresh server instance (fresh state) via createMeatbagApp()
 * and binds it to a random OS-assigned port. global.fetch is mocked to intercept
 * Telegram API calls. Test HTTP requests use Node's http module directly so they
 * are NOT intercepted by the fetch mock.
 */

import * as http from "http";
import { createMeatbagApp, MeatbagApp } from "./service";

// ── HTTP helpers using Node's http module ─────────────────────────────────────
// These bypass global.fetch so they reach the real test server.

function httpRequest(
  method: string,
  url: string,
  body?: string
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers: http.OutgoingHttpHeaders = { Accept: "application/json" };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(body);
    }
    const req = http.request(
      { hostname: u.hostname, port: Number(u.port), path: u.pathname, method, headers },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: data });
          }
        });
      }
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function get(baseUrl: string, path: string) {
  return httpRequest("GET", `${baseUrl}${path}`);
}

function post(baseUrl: string, path: string, data: unknown) {
  return httpRequest("POST", `${baseUrl}${path}`, JSON.stringify(data));
}

function postRaw(baseUrl: string, path: string, rawBody: string) {
  return httpRequest("POST", `${baseUrl}${path}`, rawBody);
}

// ── Server lifecycle helpers ──────────────────────────────────────────────────

function startServer(): Promise<{ app: MeatbagApp; baseUrl: string }> {
  const app = createMeatbagApp("fake-token", "123456");
  return new Promise((resolve, reject) => {
    app.server.listen(0, "127.0.0.1", () => {
      const addr = app.server.address() as { port: number };
      resolve({ app, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
    app.server.on("error", reject);
  });
}

function stopServer(app: MeatbagApp): Promise<void> {
  return new Promise((resolve, reject) => {
    app.server.close((err) => (err ? reject(err) : resolve()));
  });
}

// ── Mock global.fetch for Telegram calls ─────────────────────────────────────

let mockFetch: jest.Mock;

beforeEach(() => {
  mockFetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => "ok",
    json: async () => ({ ok: true, result: [] }),
  });
  global.fetch = mockFetch as unknown as typeof fetch;
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ── GET /health ───────────────────────────────────────────────────────────────

describe("GET /health", () => {
  let app: MeatbagApp;
  let baseUrl: string;

  beforeEach(async () => {
    ({ app, baseUrl } = await startServer());
  });

  afterEach(async () => {
    await stopServer(app);
  });

  it("returns status ok with zero queue and null active on fresh server", async () => {
    const { status, body } = await get(baseUrl, "/health");
    expect(status).toBe(200);
    expect(body).toEqual({ status: "ok", queued: 0, active: null });
  });

  it("reflects queue depth while first request is active (second queued)", async () => {
    // Block Telegram send for the first request
    let resolveFirstSend!: () => void;
    mockFetch.mockImplementation(
      () =>
        new Promise<{ ok: boolean; status: number; text: () => Promise<string> }>((resolve) => {
          resolveFirstSend = () => resolve({ ok: true, status: 200, text: async () => "ok" });
        })
    );

    await post(baseUrl, "/request", { question: "Q1" });
    await post(baseUrl, "/request", { question: "Q2" });

    // Let processQueue tick (dispatches Q1 to Telegram — it hangs)
    await new Promise((r) => setTimeout(r, 30));

    const { body } = await get(baseUrl, "/health");
    const b = body as { status: string; queued: number; active: string | null };
    expect(b.status).toBe("ok");
    expect(b.queued).toBe(1); // Q2 waiting
    expect(b.active).not.toBeNull(); // Q1 active

    // Unblock first send so server doesn't hang after test
    resolveFirstSend();
    await new Promise((r) => setTimeout(r, 10));
  });
});

// ── Unknown routes ────────────────────────────────────────────────────────────

describe("unknown routes", () => {
  let app: MeatbagApp;
  let baseUrl: string;

  beforeEach(async () => {
    ({ app, baseUrl } = await startServer());
  });

  afterEach(async () => {
    await stopServer(app);
  });

  it("returns 404 for unknown GET path", async () => {
    const { status, body } = await get(baseUrl, "/unknown");
    expect(status).toBe(404);
    expect((body as { error: string }).error).toBe("not found");
  });

  it("returns 404 for unknown POST path", async () => {
    const { status } = await post(baseUrl, "/unknown", {});
    expect(status).toBe(404);
  });

  it("returns 404 for GET /response without an id segment", async () => {
    const { status } = await get(baseUrl, "/response/");
    expect(status).toBe(404);
  });
});

// ── POST /request ─────────────────────────────────────────────────────────────

describe("POST /request", () => {
  let app: MeatbagApp;
  let baseUrl: string;

  beforeEach(async () => {
    ({ app, baseUrl } = await startServer());
  });

  afterEach(async () => {
    await stopServer(app);
  });

  it("returns 200 with a UUID request_id for a valid question", async () => {
    const { status, body } = await post(baseUrl, "/request", { question: "Are you there?" });
    expect(status).toBe(200);
    const id = (body as { request_id: string }).request_id;
    expect(typeof id).toBe("string");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("returns 400 when question field is missing", async () => {
    const { status, body } = await post(baseUrl, "/request", { image_path: "/tmp/img.png" });
    expect(status).toBe(400);
    expect((body as { error: string }).error).toMatch(/question/);
  });

  it("returns 400 when question is an empty string", async () => {
    const { status, body } = await post(baseUrl, "/request", { question: "" });
    expect(status).toBe(400);
    expect((body as { error: string }).error).toMatch(/question/);
  });

  it("returns 400 when question is not a string (number)", async () => {
    const { status, body } = await post(baseUrl, "/request", { question: 42 });
    expect(status).toBe(400);
    expect((body as { error: string }).error).toMatch(/question/);
  });

  it("returns 400 for invalid JSON body", async () => {
    const { status, body } = await postRaw(baseUrl, "/request", "not-json{");
    expect(status).toBe(400);
    expect((body as { error: string }).error).toMatch(/invalid JSON/);
  });

  it("accepts optional image_path and context fields", async () => {
    const { status, body } = await post(baseUrl, "/request", {
      question: "Look at this",
      image_path: "/tmp/img.png",
      context: "deployment context",
    });
    expect(status).toBe(200);
    expect(typeof (body as { request_id: string }).request_id).toBe("string");
  });

  it("dispatches only one request to Telegram when two are queued simultaneously", async () => {
    // Block first Telegram send so Q1 stays active while Q2 is queued
    let resolveFirst!: () => void;
    mockFetch.mockImplementation(
      () =>
        new Promise<{ ok: boolean; status: number; text: () => Promise<string> }>((resolve) => {
          resolveFirst = () => resolve({ ok: true, status: 200, text: async () => "" });
        })
    );

    await post(baseUrl, "/request", { question: "Q1" });
    await post(baseUrl, "/request", { question: "Q2" });

    await new Promise((r) => setTimeout(r, 30));

    // Only Q1 was dispatched; Q2 is waiting in the queue
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Unblock Q1's send (it's now "active", awaiting reply)
    resolveFirst();
    await new Promise((r) => setTimeout(r, 30));

    // Q2 still NOT dispatched — active slot held until Q1 gets an answer
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("dispatches second request after first receives an answer", async () => {
    const { body: b1 } = await post(baseUrl, "/request", { question: "Q1" });
    const { body: b2 } = await post(baseUrl, "/request", { question: "Q2" });
    const id1 = (b1 as { request_id: string }).request_id;

    await new Promise((r) => setTimeout(r, 30));
    // Q1 sent to Telegram (1 call), Q2 queued
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(typeof (b2 as { request_id: string }).request_id).toBe("string");

    // Deliver Q1's answer → releases active slot → processQueue dispatches Q2
    app.deliverAnswer(id1, "Done with Q1");
    await new Promise((r) => setTimeout(r, 30));

    // Q2 should now be sent to Telegram (2 total calls)
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

// ── GET /response/:id ─────────────────────────────────────────────────────────

describe("GET /response/:id", () => {
  let app: MeatbagApp;
  let baseUrl: string;

  beforeEach(async () => {
    ({ app, baseUrl } = await startServer());
  });

  afterEach(async () => {
    await stopServer(app);
  });

  it("returns 404 for an unknown request id", async () => {
    const { status, body } = await get(baseUrl, "/response/nonexistent-uuid");
    expect(status).toBe(404);
    expect((body as { error: string }).error).toBe("request not found");
  });

  it("returns answer immediately when already answered", async () => {
    const { body: reqBody } = await post(baseUrl, "/request", { question: "Q?" });
    const { request_id } = reqBody as { request_id: string };

    // Deliver answer programmatically (no Telegram polling needed)
    await new Promise((r) => setTimeout(r, 20)); // let processQueue fire
    const delivered = app.deliverAnswer(request_id, "Yes!");
    expect(delivered).toBe(true);

    const { status, body } = await get(baseUrl, `/response/${request_id}`);
    expect(status).toBe(200);
    expect((body as { answer: string }).answer).toBe("Yes!");
  });

  it("returns 502 immediately when failReason is already set", async () => {
    // Telegram send fails
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
      json: async () => ({}),
    });

    const { body: reqBody } = await post(baseUrl, "/request", { question: "Will fail" });
    const { request_id } = reqBody as { request_id: string };

    // Wait for processQueue to run and fail
    await new Promise((r) => setTimeout(r, 50));

    const { status, body } = await get(baseUrl, `/response/${request_id}`);
    expect(status).toBe(502);
    expect((body as { error: string }).error).toMatch(/Telegram error/);
  });

  it("returns answer via long-poll waiter when deliverAnswer is called", async () => {
    // Block Telegram send so the request stays in active state (waiter is registered)
    let resolveSend!: () => void;
    mockFetch.mockImplementation(
      () =>
        new Promise<{ ok: boolean; status: number; text: () => Promise<string> }>((resolve) => {
          resolveSend = () => resolve({ ok: true, status: 200, text: async () => "" });
        })
    );

    const { body: reqBody } = await post(baseUrl, "/request", { question: "Any news?" });
    const { request_id } = reqBody as { request_id: string };

    // Let processQueue run (Telegram call is pending/hanging)
    await new Promise((r) => setTimeout(r, 20));

    // Start long-polling in background
    const pollPromise = get(baseUrl, `/response/${request_id}`);

    // Give the poll a moment to register as a waiter
    await new Promise((r) => setTimeout(r, 20));

    // Deliver answer programmatically — resolves the waiter
    resolveSend(); // unblock Telegram send first
    await new Promise((r) => setTimeout(r, 20));
    app.deliverAnswer(request_id, "The answer is 42");

    const { status, body } = await pollPromise;
    expect(status).toBe(200);
    expect((body as { answer: string }).answer).toBe("The answer is 42");
  });

  it("returns 502 via long-poll waiter when Telegram send fails during polling", async () => {
    // Delay Telegram failure
    let rejectSend!: (err: Error) => void;
    mockFetch.mockImplementation(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectSend = reject;
        })
    );

    const { body: reqBody } = await post(baseUrl, "/request", { question: "Delayed fail" });
    const { request_id } = reqBody as { request_id: string };

    // Let processQueue run and start Telegram send (hangs)
    await new Promise((r) => setTimeout(r, 20));

    // Start long-polling
    const pollPromise = get(baseUrl, `/response/${request_id}`);

    // Wait for poll to register as waiter
    await new Promise((r) => setTimeout(r, 20));

    // Fail the Telegram send — triggers waiter with null
    rejectSend(new Error("network failure"));

    const { status, body } = await pollPromise;
    expect(status).toBe(502);
    expect((body as { error: string }).error).toMatch(/Telegram error/);
  });
});

// ── Queue ordering ────────────────────────────────────────────────────────────

describe("queue ordering", () => {
  let app: MeatbagApp;
  let baseUrl: string;

  beforeEach(async () => {
    ({ app, baseUrl } = await startServer());
  });

  afterEach(async () => {
    await stopServer(app);
  });

  it("processes requests sequentially in FIFO order via answer delivery", async () => {
    const { body: b1 } = await post(baseUrl, "/request", { question: "First" });
    const { body: b2 } = await post(baseUrl, "/request", { question: "Second" });
    const id1 = (b1 as { request_id: string }).request_id;
    const id2 = (b2 as { request_id: string }).request_id;
    expect(typeof id1).toBe("string");
    expect(typeof id2).toBe("string");

    // processQueue: Q1 sent to Telegram (1 call), Q2 stays queued
    await new Promise((r) => setTimeout(r, 30));
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Answer Q1 → releases slot → processQueue dispatches Q2
    app.deliverAnswer(id1, "Answer to first");
    await new Promise((r) => setTimeout(r, 30));
    expect(mockFetch).toHaveBeenCalledTimes(2); // Q2 now sent to Telegram

    // Deliver Q2's answer too (cleanup)
    app.deliverAnswer(id2, "Answer to second");
  });

  it("answer for second request is independent of first", async () => {
    const { body: b1 } = await post(baseUrl, "/request", { question: "Q1" });
    const { body: b2 } = await post(baseUrl, "/request", { question: "Q2" });
    const id1 = (b1 as { request_id: string }).request_id;
    const id2 = (b2 as { request_id: string }).request_id;

    await new Promise((r) => setTimeout(r, 20));
    app.deliverAnswer(id1, "Answer 1");
    // Let processQueue fire for Q2
    await new Promise((r) => setTimeout(r, 30));
    app.deliverAnswer(id2, "Answer 2");

    const { body: resp1 } = await get(baseUrl, `/response/${id1}`);
    const { body: resp2 } = await get(baseUrl, `/response/${id2}`);
    expect((resp1 as { answer: string }).answer).toBe("Answer 1");
    expect((resp2 as { answer: string }).answer).toBe("Answer 2");
  });
});
