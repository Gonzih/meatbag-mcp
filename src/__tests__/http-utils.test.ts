/**
 * Tests for the HTTP utility functions used in meatbag-service.
 *
 * We test readBody and sendJson by reimplementing them here (same code) and
 * using minimal mock request/response objects — no need to spin up a real
 * HTTP server or import service.ts (which would call process.exit on import).
 */

import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";

// ── Extracted implementations under test ─────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer | string) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

// ── Mock factories ────────────────────────────────────────────────────────────

function makeMockRequest(chunks: string[] = []): IncomingMessage {
  const emitter = new EventEmitter() as IncomingMessage;
  // Emit data chunks and end on next tick so listeners can be attached first
  process.nextTick(() => {
    for (const chunk of chunks) emitter.emit("data", chunk);
    emitter.emit("end");
  });
  return emitter;
}

function makeMockErrorRequest(err: Error): IncomingMessage {
  const emitter = new EventEmitter() as IncomingMessage;
  process.nextTick(() => emitter.emit("error", err));
  return emitter;
}

interface MockResponse {
  statusCode: number | undefined;
  headers: Record<string, string>;
  body: string;
  destroyed: boolean;
  writableEnded: boolean;
  writeHead: (status: number, headers: Record<string, string>) => void;
  end: (body: string) => void;
}

function makeMockResponse(overrides: Partial<MockResponse> = {}): ServerResponse {
  const mock: MockResponse = {
    statusCode: undefined,
    headers: {},
    body: "",
    destroyed: false,
    writableEnded: false,
    writeHead(status, hdrs) {
      this.statusCode = status;
      Object.assign(this.headers, hdrs);
    },
    end(body) {
      this.body = body;
      this.writableEnded = true;
    },
    ...overrides,
  };
  return mock as unknown as ServerResponse;
}

// ── readBody tests ────────────────────────────────────────────────────────────

describe("readBody", () => {
  it("resolves with empty string for no data", async () => {
    const req = makeMockRequest([]);
    expect(await readBody(req)).toBe("");
  });

  it("resolves with a single chunk", async () => {
    const req = makeMockRequest(["hello"]);
    expect(await readBody(req)).toBe("hello");
  });

  it("concatenates multiple chunks", async () => {
    const req = makeMockRequest(["foo", "bar", "baz"]);
    expect(await readBody(req)).toBe("foobarbaz");
  });

  it("concatenates JSON split across chunks", async () => {
    const req = makeMockRequest(['{"q', 'uestion":"', 'test"}']);
    const body = await readBody(req);
    expect(JSON.parse(body)).toEqual({ question: "test" });
  });

  it("rejects when the request emits an error", async () => {
    const req = makeMockErrorRequest(new Error("connection reset"));
    await expect(readBody(req)).rejects.toThrow("connection reset");
  });
});

// ── sendJson tests ────────────────────────────────────────────────────────────

describe("sendJson", () => {
  it("sets the correct status code", () => {
    const res = makeMockResponse();
    sendJson(res, 200, { status: "ok" });
    const mock = res as unknown as MockResponse;
    expect(mock.statusCode).toBe(200);
  });

  it("sets Content-Type: application/json header", () => {
    const res = makeMockResponse();
    sendJson(res, 200, {});
    const mock = res as unknown as MockResponse;
    expect(mock.headers["Content-Type"]).toBe("application/json");
  });

  it("serializes the data as JSON", () => {
    const res = makeMockResponse();
    sendJson(res, 200, { answer: "yes", count: 3 });
    const mock = res as unknown as MockResponse;
    expect(JSON.parse(mock.body)).toEqual({ answer: "yes", count: 3 });
  });

  it("works with a 400 status and error body", () => {
    const res = makeMockResponse();
    sendJson(res, 400, { error: "bad request" });
    const mock = res as unknown as MockResponse;
    expect(mock.statusCode).toBe(400);
    expect(JSON.parse(mock.body)).toEqual({ error: "bad request" });
  });

  it("works with a 404 status", () => {
    const res = makeMockResponse();
    sendJson(res, 404, { error: "not found" });
    const mock = res as unknown as MockResponse;
    expect(mock.statusCode).toBe(404);
  });

  it("is a no-op when response is already ended", () => {
    const res = makeMockResponse({ writableEnded: true });
    const writeHead = vi.spyOn(res, "writeHead" as never);
    sendJson(res, 200, { should: "not be sent" });
    expect(writeHead).not.toHaveBeenCalled();
  });

  it("is a no-op when response is destroyed", () => {
    const res = makeMockResponse({ destroyed: true });
    const writeHead = vi.spyOn(res, "writeHead" as never);
    sendJson(res, 200, { should: "not be sent" });
    expect(writeHead).not.toHaveBeenCalled();
  });

  it("serializes nested objects correctly", () => {
    const res = makeMockResponse();
    sendJson(res, 200, { nested: { a: 1, b: [2, 3] } });
    const mock = res as unknown as MockResponse;
    expect(JSON.parse(mock.body)).toEqual({ nested: { a: 1, b: [2, 3] } });
  });
});
