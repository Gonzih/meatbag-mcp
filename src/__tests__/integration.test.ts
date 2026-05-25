/**
 * Integration tests for meatbag-service via a real bound TCP socket.
 *
 * These complement the unit tests in service-core.test.ts (which call the
 * handler function directly via mocked Node IncomingMessage/ServerResponse).
 *
 * Here we:
 * - bind a real http.Server to an ephemeral OS-assigned port
 * - make real HTTP requests using Node's built-in http module
 * - verify end-to-end behavior through actual TCP + HTTP parsing
 *
 * This catches issues that mock-based unit tests cannot: HTTP header parsing,
 * chunked bodies, concurrent connections, and server lifecycle.
 */

import { createServer, request as httpRequest, IncomingMessage } from "http";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createServiceState,
  createProcessQueue,
  createHttpHandler,
  ServiceState,
} from "../service-core";

// ── Server factory ────────────────────────────────────────────────────────────

interface TestApp {
  baseUrl: string;
  state: ServiceState;
  tgSend: ReturnType<typeof vi.fn>;
  close: () => Promise<void>;
  /** Deliver an answer to a pending request (simulates Telegram reply). */
  deliverAnswer: (requestId: string, answer: string) => boolean;
}

async function startApp(longPollTimeoutMs = 200): Promise<TestApp> {
  const state = createServiceState();
  const tgSend = vi.fn().mockResolvedValue(undefined);
  const processQueue = createProcessQueue(state, tgSend, () => {});
  const handler = createHttpHandler(state, processQueue, () => {}, {
    longPollTimeoutMs,
  });

  const server = createServer((req, res) => {
    handler(req, res).catch((err: Error) => {
      if (!res.writableEnded) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  function deliverAnswer(requestId: string, answer: string): boolean {
    const entry = state.requests.get(requestId);
    if (!entry || entry.answer !== undefined || entry.failReason !== undefined) {
      return false;
    }
    entry.answer = answer;
    state.activeRequestId = null;
    for (const waiter of entry.waiters) waiter(answer);
    entry.waiters = [];
    // Dispatch the next queued request now that the slot is free
    void processQueue();
    return true;
  }

  return {
    baseUrl,
    state,
    tgSend,
    deliverAnswer,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

// ── HTTP client helper ────────────────────────────────────────────────────────
// Uses Node's built-in http module — does NOT go through global.fetch.

function req(
  method: string,
  url: string,
  body?: string
): Promise<{ status: number; headers: Record<string, string>; body: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      port: Number(u.port),
      path: u.pathname,
      method,
      headers: body
        ? ({ "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } as Record<string, string | number>)
        : ({} as Record<string, string | number>),
    };
    const r = httpRequest(opts, (res: IncomingMessage) => {
      let raw = "";
      res.on("data", (c: Buffer) => (raw += c));
      res.on("end", () => {
        try {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers as Record<string, string>,
            body: JSON.parse(raw),
          });
        } catch {
          resolve({ status: res.statusCode ?? 0, headers: res.headers as Record<string, string>, body: raw });
        }
      });
    });
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}

const get = (url: string, path: string) => req("GET", `${url}${path}`);
const post = (url: string, path: string, data: unknown) =>
  req("POST", `${url}${path}`, JSON.stringify(data));
const postRaw = (url: string, path: string, raw: string) =>
  req("POST", `${url}${path}`, raw);

// ── Test setup ────────────────────────────────────────────────────────────────

let app: TestApp;

beforeEach(async () => {
  app = await startApp();
});

afterEach(async () => {
  await app.close();
});

// ── GET /health ───────────────────────────────────────────────────────────────

describe("GET /health (integration)", () => {
  test("returns JSON with status ok, queued 0, active null on fresh server", async () => {
    const { status, body, headers } = await get(app.baseUrl, "/health");
    expect(status).toBe(200);
    expect(headers["content-type"]).toMatch(/application\/json/);
    expect(body).toEqual({ status: "ok", queued: 0, active: null });
  });

  test("reflects queue depth while first request is being sent to Telegram", async () => {
    // Block Telegram send so the first request stays active
    let resolveFirst!: () => void;
    app.tgSend.mockImplementation(
      () => new Promise<void>((resolve) => { resolveFirst = resolve; })
    );

    await post(app.baseUrl, "/request", { question: "Q1" });
    await post(app.baseUrl, "/request", { question: "Q2" });

    // Allow processQueue to tick (dispatches Q1, which hangs)
    await new Promise((r) => setTimeout(r, 30));

    const { body } = await get(app.baseUrl, "/health");
    const b = body as { status: string; queued: number; active: string | null };
    expect(b.status).toBe("ok");
    expect(b.queued).toBe(1);
    expect(b.active).not.toBeNull();

    resolveFirst();
    await new Promise((r) => setTimeout(r, 10));
  });
});

// ── POST /request ─────────────────────────────────────────────────────────────

describe("POST /request (integration)", () => {
  test("returns 200 and a UUID request_id for a valid question", async () => {
    const { status, body } = await post(app.baseUrl, "/request", { question: "Hello?" });
    expect(status).toBe(200);
    const id = (body as { request_id: string }).request_id;
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("stores the request in state after POST", async () => {
    const { body } = await post(app.baseUrl, "/request", { question: "Stored?" });
    const { request_id } = body as { request_id: string };
    await new Promise((r) => setTimeout(r, 20));
    expect(app.state.requests.has(request_id)).toBe(true);
    expect(app.state.requests.get(request_id)?.question).toBe("Stored?");
  });

  test("returns 400 for missing question", async () => {
    const { status, body } = await post(app.baseUrl, "/request", { context: "no question" });
    expect(status).toBe(400);
    expect((body as { error: string }).error).toMatch(/question/);
  });

  test("returns 400 for empty question string", async () => {
    const { status } = await post(app.baseUrl, "/request", { question: "" });
    expect(status).toBe(400);
  });

  test("returns 400 for non-string question", async () => {
    const { status } = await post(app.baseUrl, "/request", { question: true });
    expect(status).toBe(400);
  });

  test("returns 400 for invalid JSON body", async () => {
    const { status, body } = await postRaw(app.baseUrl, "/request", "not-json{{{");
    expect(status).toBe(400);
    expect((body as { error: string }).error).toMatch(/invalid JSON/);
  });

  test("accepts and stores image_path and context", async () => {
    const { body } = await post(app.baseUrl, "/request", {
      question: "Look at this",
      image_path: "/tmp/screenshot.png",
      context: "deployment context",
    });
    const { request_id } = body as { request_id: string };
    await new Promise((r) => setTimeout(r, 20));
    const entry = app.state.requests.get(request_id);
    expect(entry?.image_path).toBe("/tmp/screenshot.png");
    expect(entry?.context).toBe("deployment context");
  });

  test("dispatches Telegram send after POST", async () => {
    await post(app.baseUrl, "/request", { question: "Send this" });
    await new Promise((r) => setTimeout(r, 30));
    expect(app.tgSend).toHaveBeenCalledTimes(1);
  });

  test("second POST while first is active does NOT trigger second Telegram send", async () => {
    // Block first Telegram send
    let resolveFirst!: () => void;
    app.tgSend.mockImplementation(
      () => new Promise<void>((resolve) => { resolveFirst = resolve; })
    );

    await post(app.baseUrl, "/request", { question: "Q1" });
    await post(app.baseUrl, "/request", { question: "Q2" });
    await new Promise((r) => setTimeout(r, 30));

    // Only one Telegram call — Q2 held in queue
    expect(app.tgSend).toHaveBeenCalledTimes(1);

    resolveFirst();
    await new Promise((r) => setTimeout(r, 10));
  });

  test("chunked request body is assembled correctly", async () => {
    // Send body in two chunks using a raw TCP approach
    const result = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const u = new URL(`${app.baseUrl}/request`);
      const bodyPart1 = '{"question":"chunked';
      const bodyPart2 = ' body test"}';
      const fullBody = bodyPart1 + bodyPart2;

      const r = httpRequest(
        {
          hostname: u.hostname,
          port: Number(u.port),
          path: "/request",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(fullBody),
          },
        },
        (res) => {
          let raw = "";
          res.on("data", (c: Buffer) => (raw += c));
          res.on("end", () => {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) });
          });
        }
      );
      r.on("error", reject);
      // Write in two separate chunks
      r.write(bodyPart1);
      setImmediate(() => r.end(bodyPart2));
    });

    expect(result.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    const id = (result.body as { request_id: string }).request_id;
    expect(app.state.requests.get(id)?.question).toBe("chunked body test");
  });
});

// ── GET /response/:id ─────────────────────────────────────────────────────────

describe("GET /response/:id (integration)", () => {
  test("returns 404 for unknown request id", async () => {
    const { status, body } = await get(app.baseUrl, "/response/nonexistent-id");
    expect(status).toBe(404);
    expect((body as { error: string }).error).toBe("request not found");
  });

  test("returns answer immediately when already answered", async () => {
    const { body: reqBody } = await post(app.baseUrl, "/request", { question: "Q?" });
    const { request_id } = reqBody as { request_id: string };

    await new Promise((r) => setTimeout(r, 20));
    app.deliverAnswer(request_id, "Ready answer");

    const { status, body } = await get(app.baseUrl, `/response/${request_id}`);
    expect(status).toBe(200);
    expect((body as { answer: string }).answer).toBe("Ready answer");
  });

  test("returns 502 immediately when failReason is already set", async () => {
    app.tgSend.mockRejectedValue(new Error("Telegram is down"));

    const { body: reqBody } = await post(app.baseUrl, "/request", { question: "Will fail" });
    const { request_id } = reqBody as { request_id: string };
    await new Promise((r) => setTimeout(r, 50));

    const { status, body } = await get(app.baseUrl, `/response/${request_id}`);
    expect(status).toBe(502);
    expect((body as { error: string }).error).toMatch(/Telegram error/);
  });

  test("long-poll returns answer via waiter when deliverAnswer is called", async () => {
    // Block Telegram send so the request stays in active state
    let resolveSend!: () => void;
    app.tgSend.mockImplementation(
      () => new Promise<void>((resolve) => { resolveSend = resolve; })
    );

    const { body: reqBody } = await post(app.baseUrl, "/request", { question: "Waiting..." });
    const { request_id } = reqBody as { request_id: string };
    await new Promise((r) => setTimeout(r, 20));

    // Start long-polling in parallel
    const pollPromise = get(app.baseUrl, `/response/${request_id}`);
    await new Promise((r) => setTimeout(r, 20)); // let it register as waiter

    // Unblock send, then deliver the answer
    resolveSend();
    await new Promise((r) => setTimeout(r, 20));
    app.deliverAnswer(request_id, "Here is your answer");

    const { status, body } = await pollPromise;
    expect(status).toBe(200);
    expect((body as { answer: string }).answer).toBe("Here is your answer");
  });

  test("long-poll returns 502 via waiter when Telegram send fails during polling", async () => {
    let rejectSend!: (err: Error) => void;
    app.tgSend.mockImplementation(
      () => new Promise<void>((_, reject) => { rejectSend = reject; })
    );

    const { body: reqBody } = await post(app.baseUrl, "/request", { question: "Failure case" });
    const { request_id } = reqBody as { request_id: string };
    await new Promise((r) => setTimeout(r, 20));

    const pollPromise = get(app.baseUrl, `/response/${request_id}`);
    await new Promise((r) => setTimeout(r, 20));

    rejectSend(new Error("network timeout"));

    const { status, body } = await pollPromise;
    expect(status).toBe(502);
    expect((body as { error: string }).error).toMatch(/Telegram error/);
  });

  test("long-poll returns empty {} on timeout (no answer within longPollTimeoutMs)", async () => {
    // Use very short poll timeout (200ms from startApp)
    const { body: reqBody } = await post(app.baseUrl, "/request", { question: "Will timeout" });
    const { request_id } = reqBody as { request_id: string };
    await new Promise((r) => setTimeout(r, 20));

    // Start long-poll — server will return {} after 200ms (set in startApp)
    const { status, body } = await get(app.baseUrl, `/response/${request_id}`);
    expect(status).toBe(200);
    expect(body).toEqual({});
  }, 5000);

  test("multiple concurrent pollers all receive the same answer", async () => {
    let resolveSend!: () => void;
    app.tgSend.mockImplementation(
      () => new Promise<void>((resolve) => { resolveSend = resolve; })
    );

    const { body: reqBody } = await post(app.baseUrl, "/request", { question: "Concurrent?" });
    const { request_id } = reqBody as { request_id: string };
    await new Promise((r) => setTimeout(r, 20));

    // Launch 3 concurrent long-poll requests
    const polls = [
      get(app.baseUrl, `/response/${request_id}`),
      get(app.baseUrl, `/response/${request_id}`),
      get(app.baseUrl, `/response/${request_id}`),
    ];
    await new Promise((r) => setTimeout(r, 30)); // let them register as waiters

    resolveSend();
    await new Promise((r) => setTimeout(r, 20));
    app.deliverAnswer(request_id, "Shared answer");

    const results = await Promise.all(polls);
    for (const { status, body } of results) {
      expect(status).toBe(200);
      expect((body as { answer: string }).answer).toBe("Shared answer");
    }
  });
});

// ── Unknown routes ────────────────────────────────────────────────────────────

describe("unknown routes (integration)", () => {
  test("GET /unknown returns 404", async () => {
    const { status, body } = await get(app.baseUrl, "/unknown");
    expect(status).toBe(404);
    expect((body as { error: string }).error).toBe("not found");
  });

  test("POST /unknown returns 404", async () => {
    const { status } = await post(app.baseUrl, "/unknown", {});
    expect(status).toBe(404);
  });

  test("GET / (root) returns 404", async () => {
    const { status } = await get(app.baseUrl, "/");
    expect(status).toBe(404);
  });

  test("Content-Type is application/json on all responses", async () => {
    const { headers } = await get(app.baseUrl, "/health");
    expect(headers["content-type"]).toMatch(/application\/json/);

    const { headers: h2 } = await get(app.baseUrl, "/response/nope");
    expect(h2["content-type"]).toMatch(/application\/json/);
  });
});

// ── Queue sequencing (integration) ───────────────────────────────────────────

describe("queue sequencing (integration)", () => {
  test("second request dispatched to Telegram only after first is answered", async () => {
    const { body: b1 } = await post(app.baseUrl, "/request", { question: "Q1" });
    const { body: b2 } = await post(app.baseUrl, "/request", { question: "Q2" });
    const id1 = (b1 as { request_id: string }).request_id;

    await new Promise((r) => setTimeout(r, 30));
    expect(app.tgSend).toHaveBeenCalledTimes(1); // only Q1

    // Deliver Q1's answer → processQueue dispatches Q2
    app.deliverAnswer(id1, "Done");
    await new Promise((r) => setTimeout(r, 30));
    expect(app.tgSend).toHaveBeenCalledTimes(2); // Q2 now sent

    expect(typeof (b2 as { request_id: string }).request_id).toBe("string");
  });
});
