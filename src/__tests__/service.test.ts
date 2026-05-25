/**
 * Unit tests for service.ts
 *
 * Strategy: mock `node:http` createServer to capture the handler closure,
 * mock global `fetch` for Telegram API calls, drive handler with synthetic stubs.
 *
 * State machine note: activeRequestId persists across tests (module-level).
 * Tests are ordered so state flows predictably:
 *   null → (failure test) → null → (photo test) → FIXED_UUID → (rest)
 */

import { EventEmitter } from "events";
import { IncomingMessage, ServerResponse } from "http";

// ── capture http handler BEFORE importing service ─────────────────────────────

let capturedHandler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | null = null;

const mockServer = {
  listen: jest.fn((_port: number, _host: string, _cb?: () => void) => {
    // Do NOT call _cb — prevents pollLoop() from starting
  }),
  on: jest.fn(),
};

jest.mock("http", () => ({
  createServer: jest.fn((handler) => {
    capturedHandler = handler;
    return mockServer;
  }),
}));

jest.mock("fs/promises", () => ({
  readFile: jest.fn().mockResolvedValue(Buffer.from("fake-image-bytes")),
}));

jest.mock("crypto", () => ({
  randomUUID: jest.fn(() => FIXED_UUID),
}));

const FIXED_UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

// Set env vars before requiring service
process.env.MEATBAG_BOT_TOKEN = "test-token";
process.env.MEATBAG_CHAT_ID = "12345";
process.env.MEATBAG_SERVICE_PORT = "7799";

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a minimal IncomingMessage. Uses queueMicrotask (not setImmediate) so
 * body events fire even when jest.useFakeTimers() is active.
 */
function makeReq(method: string, url: string, body = ""): IncomingMessage {
  const em = new EventEmitter() as IncomingMessage;
  Object.assign(em, { method, url });
  // Use Promise microtask (not queueMicrotask/setImmediate which Jest fakes)
  // so body events fire even when jest.useFakeTimers() is active.
  Promise.resolve().then(() => {
    em.emit("data", body);
    em.emit("end");
  });
  return em;
}

/** Like makeReq but emits an error so readBody() rejects. */
function makeErrorReq(method: string, url: string): IncomingMessage {
  const em = new EventEmitter() as IncomingMessage;
  Object.assign(em, { method, url });
  Promise.resolve().then(() => em.emit("error", new Error("stream error")));
  return em;
}

interface FakeRes {
  _status: number;
  _body: string;
  destroyed: boolean;
  writableEnded: boolean;
}

function makeRes(): ServerResponse & FakeRes {
  const em = new EventEmitter() as unknown as ServerResponse & FakeRes;
  em._status = 0;
  em._body = "";
  em.destroyed = false;
  em.writableEnded = false;
  (em as unknown as Record<string, unknown>).writeHead = jest.fn((status: number) => {
    em._status = status;
    em.writableEnded = true;
  });
  (em as unknown as Record<string, unknown>).end = jest.fn((b: string) => { em._body = b; });
  return em;
}

async function handle(method: string, url: string, body = "") {
  if (!capturedHandler) throw new Error("handler not captured");
  const req = makeReq(method, url, body);
  const res = makeRes();
  await capturedHandler(req, res as unknown as ServerResponse);
  return { status: res._status, data: JSON.parse(res._body || "{}") as unknown };
}

// ── import service (triggers module-level side effects) ───────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
require("../service");

// ── mock fetch ────────────────────────────────────────────────────────────────

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

function tgOk(body: unknown = { ok: true, result: [] }) {
  return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(""), json: () => Promise.resolve(body) } as Response);
}

function tgFail(status = 500, text = "err") {
  return Promise.resolve({ ok: false, status, text: () => Promise.resolve(text), json: () => Promise.resolve({}) } as Response);
}

afterEach(() => {
  jest.useRealTimers();
  mockFetch.mockReset();
});

// ═════════════════════════════════════════════════════════════════════════════
// 1. GET /health
// ═════════════════════════════════════════════════════════════════════════════

describe("GET /health", () => {
  it("returns status ok", async () => {
    const { status, data } = await handle("GET", "/health");
    expect(status).toBe(200);
    expect((data as Record<string, unknown>).status).toBe("ok");
    expect(typeof (data as Record<string, unknown>).queued).toBe("number");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. POST /request input validation
// ═════════════════════════════════════════════════════════════════════════════

describe("POST /request validation", () => {
  it("rejects invalid JSON", async () => {
    const { status, data } = await handle("POST", "/request", "bad-json");
    expect(status).toBe(400);
    expect((data as Record<string, unknown>).error).toMatch(/invalid JSON/i);
  });

  it("rejects missing question field", async () => {
    const { status } = await handle("POST", "/request", JSON.stringify({}));
    expect(status).toBe(400);
  });

  it("rejects empty question string", async () => {
    const { status } = await handle("POST", "/request", JSON.stringify({ question: "" }));
    expect(status).toBe(400);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. 500 error: body read failure
// ═════════════════════════════════════════════════════════════════════════════

describe("request handler error path", () => {
  it("returns 500 when request body stream errors", async () => {
    if (!capturedHandler) throw new Error("handler not captured");
    const req = makeErrorReq("POST", "/request");
    const res = makeRes();
    await capturedHandler(req, res as unknown as ServerResponse);
    expect(res._status).toBe(500);
    expect(JSON.parse(res._body).error).toMatch(/stream error/i);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. processQueue: Telegram sendMessage failure
//    Requires activeRequestId === null (first stateful test).
//    After: activeRequestId = null (cleared by catch block), failReason set.
// ═════════════════════════════════════════════════════════════════════════════

describe("processQueue: sendMessage failure", () => {
  it("sets failReason on entry when Telegram returns error", async () => {
    mockFetch.mockResolvedValue(tgFail(500, "telegram down"));

    const { status, data } = await handle(
      "POST", "/request", JSON.stringify({ question: "fail?" })
    );
    expect(status).toBe(200);
    expect((data as Record<string, unknown>).request_id).toBe(FIXED_UUID);

    // processQueue is fire-and-forget; let its microtask chain complete
    // before checking the result. One await tick is enough since fetch is
    // a mock that resolves synchronously via Promise.resolve().
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Subsequent GET should see failReason → 502 immediately
    const { status: s2, data: d2 } = await handle("GET", `/response/${FIXED_UUID}`);
    expect(s2).toBe(502);
    expect((d2 as Record<string, unknown>).error).toMatch(/Telegram error/i);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. processQueue: tgSendPhoto path
//    Requires activeRequestId === null (left null by test 4's failure).
//    After: activeRequestId = FIXED_UUID (successful send, no reply).
// ═════════════════════════════════════════════════════════════════════════════

describe("processQueue: tgSendPhoto path", () => {
  it("calls sendPhoto when image_path is provided", async () => {
    mockFetch.mockResolvedValue(tgOk());

    await handle(
      "POST", "/request",
      JSON.stringify({ question: "Look at this", image_path: "/tmp/img.jpg" })
    );

    // Let the async chain complete
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const urls = mockFetch.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("sendPhoto"))).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. POST /request success (activeRequestId already set — processQueue noop)
// ═════════════════════════════════════════════════════════════════════════════

describe("POST /request success", () => {
  it("returns request_id for valid question", async () => {
    mockFetch.mockResolvedValue(tgOk());
    const { status, data } = await handle(
      "POST", "/request", JSON.stringify({ question: "ok?", context: "prod" })
    );
    expect(status).toBe(200);
    expect((data as Record<string, unknown>).request_id).toBe(FIXED_UUID);
  });

  it("accepts optional image_path field without error", async () => {
    mockFetch.mockResolvedValue(tgOk());
    const { status, data } = await handle(
      "POST", "/request",
      JSON.stringify({ question: "img?", image_path: "/tmp/x.png" })
    );
    expect(status).toBe(200);
    expect((data as Record<string, unknown>).request_id).toBeDefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. GET /response/:id — not found
// ═════════════════════════════════════════════════════════════════════════════

describe("GET /response/:id", () => {
  it("returns 404 for unknown id", async () => {
    const { status, data } = await handle("GET", "/response/no-such-id");
    expect(status).toBe(404);
    expect((data as Record<string, unknown>).error).toMatch(/not found/i);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. GET /response/:id — long-poll timeout (30s → empty body)
// ═════════════════════════════════════════════════════════════════════════════

describe("GET /response/:id long-poll timeout", () => {
  it("returns empty {} after 30s when no answer arrives", async () => {
    jest.useFakeTimers();
    mockFetch.mockResolvedValue(tgOk());

    // POST to create an entry (processQueue returns early: slot occupied)
    const { data: d } = await handle(
      "POST", "/request", JSON.stringify({ question: "waiting?" })
    );
    const id = (d as Record<string, unknown>).request_id as string;

    // Start the long-poll (won't resolve until timer fires)
    const pollPromise = handle("GET", `/response/${id}`);

    // Fire the faked 30s timeout synchronously, then await the Promise chain
    jest.advanceTimersByTime(31_000);

    const { status, data } = await pollPromise;
    expect(status).toBe(200);
    expect(data).toEqual({});
  }, 15_000);
});

// ═════════════════════════════════════════════════════════════════════════════
// 9. Unknown routes
// ═════════════════════════════════════════════════════════════════════════════

describe("unknown routes", () => {
  it("returns 404 for unmatched paths", async () => {
    const { status } = await handle("DELETE", "/nope");
    expect(status).toBe(404);
  });

  it("returns 404 for unmatched GET paths", async () => {
    const { status } = await handle("GET", "/foo/bar");
    expect(status).toBe(404);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 10. sendJson guard: destroyed response
// ═════════════════════════════════════════════════════════════════════════════

describe("sendJson guard", () => {
  it("no-ops when res.destroyed is true", async () => {
    if (!capturedHandler) throw new Error("no handler");
    const req = makeReq("GET", "/health");
    const res = makeRes();
    res.destroyed = true;
    // Should complete without writing anything
    await capturedHandler(req, res as unknown as ServerResponse);
    expect(res._status).toBe(0);
  });
});
