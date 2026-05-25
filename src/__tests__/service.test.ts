/**
 * Unit tests for service.ts (top-level module: env-var startup, pollLoop, HTTP wrapper)
 *
 * Strategy:
 * - Mock "http" (bare, matches service.ts import) so createServer captures the handler
 * - Mock "fs/promises" for tgSendPhoto's readFile
 * - Mock "crypto" for deterministic UUIDs
 * - Wait for res.end() (not on the wrapper return value) since the createServer
 *   callback wraps handler().catch() synchronously
 *
 * State ordering: activeRequestId persists across tests.
 *   null → (failure) → null → (photo) → FIXED_UUID → (rest)
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";

// ── capture http handler BEFORE importing service ─────────────────────────────

// The merged service.ts does:
//   const httpServer = createServer((req, res) => { handler(req, res).catch(...) });
// So capturedHandler is a sync wrapper. We can't await it directly; instead we
// wait for res.end() to be called, which signals the handler completed.

type SyncWrapper = (req: IncomingMessage, res: ServerResponse) => void;
let capturedWrapper: SyncWrapper | null = null;

const mockServer = {
  listen: vi.fn((_port: number, _host: string, _cb?: () => void) => {
    // Do NOT invoke _cb — prevents pollLoop() from starting
  }),
  on: vi.fn(),
};

vi.mock("http", () => ({
  createServer: vi.fn((wrapper: SyncWrapper) => {
    capturedWrapper = wrapper;
    return mockServer;
  }),
}));

vi.mock("fs/promises", () => ({
  readFile: vi.fn().mockResolvedValue(Buffer.from("fake-image-bytes")),
}));

const FIXED_UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
vi.mock("crypto", () => ({
  randomUUID: vi.fn(() => FIXED_UUID),
}));

// Set required env vars before importing service
process.env.MEATBAG_BOT_TOKEN = "test-token";
process.env.MEATBAG_CHAT_ID = "12345";
process.env.MEATBAG_SERVICE_PORT = "7799";

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a minimal IncomingMessage. Uses Promise microtask so body events fire
 * even when vi.useFakeTimers() is active (vitest also fakes queueMicrotask but
 * not the V8 Promise queue).
 */
function makeReq(method: string, url: string, body = ""): IncomingMessage {
  const em = new EventEmitter() as unknown as IncomingMessage;
  Object.assign(em, { method, url });
  Promise.resolve().then(() => {
    em.emit("data", body);
    em.emit("end");
  });
  return em;
}

function makeErrorReq(method: string, url: string): IncomingMessage {
  const em = new EventEmitter() as unknown as IncomingMessage;
  Object.assign(em, { method, url });
  Promise.resolve().then(() => em.emit("error", new Error("stream error")));
  return em;
}

interface FakeRes {
  _status: number;
  _body: string;
  destroyed: boolean;
  writableEnded: boolean;
  _done: Promise<void>;
}

function makeRes(): ServerResponse & FakeRes {
  const em = new EventEmitter() as unknown as ServerResponse & FakeRes;
  em._status = 0;
  em._body = "";
  em.destroyed = false;
  em.writableEnded = false;
  let _resolve: () => void;
  em._done = new Promise<void>((r) => { _resolve = r; });
  (em as unknown as Record<string, unknown>).writeHead = vi.fn((status: number) => {
    em._status = status;
    em.writableEnded = true;
  });
  (em as unknown as Record<string, unknown>).end = vi.fn((b: string) => {
    em._body = b;
    _resolve();
  });
  return em;
}

/**
 * Invoke the captured HTTP wrapper and wait for res.end() to be called.
 * This is necessary because createServer wraps handler().catch() synchronously.
 */
async function handle(method: string, url: string, body = "") {
  if (!capturedWrapper) throw new Error("wrapper not captured — module not loaded?");
  const req = makeReq(method, url, body);
  const res = makeRes();
  capturedWrapper(req, res as unknown as ServerResponse);
  await res._done;
  return { status: res._status, data: JSON.parse(res._body || "{}") as unknown };
}

// ── mock fetch ────────────────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function tgOk() {
  return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(""), json: () => Promise.resolve({ ok: true, result: [] }) } as Response);
}
function tgFail(status = 500, text = "err") {
  return Promise.resolve({ ok: false, status, text: () => Promise.resolve(text), json: () => Promise.resolve({}) } as Response);
}

// ── import service (triggers module-level side effects) ───────────────────────

await import("../service");

afterEach(() => {
  vi.useRealTimers();
  mockFetch.mockReset();
});

// ═════════════════════════════════════════════════════════════════════════════
// 1. GET /health
// ═════════════════════════════════════════════════════════════════════════════

describe("GET /health", () => {
  it("returns status ok with queue info", async () => {
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
  it("rejects invalid JSON → 400", async () => {
    const { status, data } = await handle("POST", "/request", "bad-json");
    expect(status).toBe(400);
    expect((data as Record<string, unknown>).error).toMatch(/invalid JSON/i);
  });

  it("rejects missing question field → 400", async () => {
    const { status } = await handle("POST", "/request", JSON.stringify({}));
    expect(status).toBe(400);
  });

  it("rejects empty question string → 400", async () => {
    const { status } = await handle("POST", "/request", JSON.stringify({ question: "" }));
    expect(status).toBe(400);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. 500 error: body read failure
// ═════════════════════════════════════════════════════════════════════════════

describe("request handler error path", () => {
  it("returns 500 when request body stream errors", async () => {
    if (!capturedWrapper) throw new Error("wrapper not captured");
    const req = makeErrorReq("POST", "/request");
    const res = makeRes();
    capturedWrapper(req, res as unknown as ServerResponse);
    await res._done;
    expect(res._status).toBe(500);
    expect((JSON.parse(res._body) as Record<string, unknown>).error).toMatch(/stream error/i);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. processQueue: Telegram sendMessage failure
//    Requires activeRequestId === null (first stateful test).
//    After: activeRequestId = null (cleared by catch), failReason set.
// ═════════════════════════════════════════════════════════════════════════════

describe("processQueue: sendMessage failure", () => {
  it("sets failReason when Telegram returns error → GET /response 502", async () => {
    mockFetch.mockResolvedValue(tgFail(500, "telegram down"));

    const { status, data } = await handle(
      "POST", "/request", JSON.stringify({ question: "fail?" })
    );
    expect(status).toBe(200);
    expect((data as Record<string, unknown>).request_id).toBe(FIXED_UUID);

    // Let processQueue's async chain complete (fetch is mocked to resolve immediately)
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const { status: s2, data: d2 } = await handle("GET", `/response/${FIXED_UUID}`);
    expect(s2).toBe(502);
    expect((d2 as Record<string, unknown>).error).toMatch(/Telegram error/i);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. processQueue: tgSendPhoto path
//    Requires activeRequestId === null (left null by test 4).
//    After: activeRequestId = FIXED_UUID.
// ═════════════════════════════════════════════════════════════════════════════

describe("processQueue: tgSendPhoto path", () => {
  it("calls sendPhoto endpoint when image_path provided", async () => {
    mockFetch.mockResolvedValue(tgOk());
    await handle("POST", "/request", JSON.stringify({ question: "see?", image_path: "/tmp/img.jpg" }));

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const urls = mockFetch.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("sendPhoto"))).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. POST /request success (activeRequestId set — processQueue returns early)
// ═════════════════════════════════════════════════════════════════════════════

describe("POST /request success", () => {
  it("returns request_id for valid question with context", async () => {
    mockFetch.mockResolvedValue(tgOk());
    const { status, data } = await handle(
      "POST", "/request", JSON.stringify({ question: "ok?", context: "prod" })
    );
    expect(status).toBe(200);
    expect((data as Record<string, unknown>).request_id).toBe(FIXED_UUID);
  });

  it("accepts optional image_path field", async () => {
    mockFetch.mockResolvedValue(tgOk());
    const { status, data } = await handle(
      "POST", "/request", JSON.stringify({ question: "img?", image_path: "/tmp/x.png" })
    );
    expect(status).toBe(200);
    expect((data as Record<string, unknown>).request_id).toBeDefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. GET /response/:id — not found
// ═════════════════════════════════════════════════════════════════════════════

describe("GET /response/:id — not found", () => {
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
  it("returns {} after 30s when no answer arrives", async () => {
    vi.useFakeTimers();
    mockFetch.mockResolvedValue(tgOk());

    // POST creates entry; processQueue returns early (slot occupied)
    const { data: d } = await handle("POST", "/request", JSON.stringify({ question: "waiting?" }));
    const id = (d as Record<string, unknown>).request_id as string;

    // Start long-poll — held until timer fires
    const res = makeRes();
    capturedWrapper!(makeReq("GET", `/response/${id}`), res as unknown as ServerResponse);

    // Fire the faked 30s timeout → res.end() called → res._done resolves
    vi.advanceTimersByTime(31_000);
    await res._done;

    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual({});
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
  it("no-ops when res.destroyed is true (does not write to response)", async () => {
    if (!capturedWrapper) throw new Error("no wrapper");
    const req = makeReq("GET", "/health");
    const res = makeRes();
    res.destroyed = true;
    // With destroyed=true, sendJson returns early — res.end() is never called.
    // We just verify the wrapper doesn't throw and the status is never set.
    capturedWrapper(req, res as unknown as ServerResponse);
    // Give the handler a moment to run through its async path
    await new Promise((r) => setTimeout(r, 10));
    expect(res._status).toBe(0);
  });
});
