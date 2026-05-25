import { describe, test, expect, vi } from "vitest";
import { EventEmitter } from "events";
import { IncomingMessage, ServerResponse } from "http";
import { readBody, sendJson } from "../http-utils";

function makeRequest(body: string): IncomingMessage {
  const emitter = new EventEmitter() as IncomingMessage;
  setImmediate(() => { emitter.emit("data", body); emitter.emit("end"); });
  return emitter;
}

function makeErrorRequest(error: Error): IncomingMessage {
  const emitter = new EventEmitter() as IncomingMessage;
  setImmediate(() => { emitter.emit("error", error); });
  return emitter;
}

function makeResponse() {
  const res = new EventEmitter() as any;
  res.destroyed = false; res.writableEnded = false;
  res._status = 0; res._headers = {}; res._body = "";
  res.writeHead = vi.fn((status: number, headers: Record<string, string>) => {
    res._status = status; res._headers = { ...res._headers, ...headers };
  });
  res.end = vi.fn((body: string) => { res._body = body; res.writableEnded = true; });
  return res as ServerResponse & { _status: number; _headers: Record<string, string>; _body: string };
}

describe("readBody", () => {
  test("resolves with full body string", async () => {
    expect(await readBody(makeRequest("hello world"))).toBe("hello world");
  });
  test("resolves with empty string for empty body", async () => {
    expect(await readBody(makeRequest(""))).toBe("");
  });
  test("concatenates multiple data chunks", async () => {
    const emitter = new EventEmitter() as IncomingMessage;
    setImmediate(() => { emitter.emit("data", "chunk1"); emitter.emit("data", "-"); emitter.emit("data", "chunk2"); emitter.emit("end"); });
    expect(await readBody(emitter)).toBe("chunk1-chunk2");
  });
  test("rejects when an error event is emitted", async () => {
    await expect(readBody(makeErrorRequest(new Error("stream error")))).rejects.toThrow("stream error");
  });
  test("handles JSON bodies correctly", async () => {
    const body = await readBody(makeRequest(JSON.stringify({ question: "hello?" })));
    expect(JSON.parse(body)).toEqual({ question: "hello?" });
  });
});

describe("sendJson", () => {
  test("writes correct status, content-type header, and JSON body", () => {
    const res = makeResponse();
    sendJson(res, 200, { ok: true });
    expect(res._status).toBe(200);
    expect(res._headers["Content-Type"]).toBe("application/json");
    expect(res._body).toBe(JSON.stringify({ ok: true }));
  });
  test("works with 4xx status codes", () => {
    const res = makeResponse();
    sendJson(res, 400, { error: "bad request" });
    expect(res._status).toBe(400);
    expect(JSON.parse(res._body)).toEqual({ error: "bad request" });
  });
  test("works with 5xx status codes", () => {
    const res = makeResponse(); sendJson(res, 500, { error: "internal error" }); expect(res._status).toBe(500);
  });
  test("serializes arrays and nested objects", () => {
    const res = makeResponse(); sendJson(res, 200, [1, 2, { a: "b" }]); expect(JSON.parse(res._body)).toEqual([1, 2, { a: "b" }]);
  });
  test("serializes null", () => {
    const res = makeResponse(); sendJson(res, 200, null); expect(res._body).toBe("null");
  });
  test("no-ops when response is already destroyed", () => {
    const res = makeResponse(); res.destroyed = true; sendJson(res, 200, {}); expect(res.writeHead).not.toHaveBeenCalled();
  });
  test("no-ops when response has already ended", () => {
    const res = makeResponse(); (res as any).writableEnded = true; sendJson(res, 200, {}); expect(res.writeHead).not.toHaveBeenCalled();
  });
  test("calls writeHead then end in order", () => {
    const res = makeResponse(); const order: string[] = [];
    (res.writeHead as ReturnType<typeof vi.fn>).mockImplementation(() => order.push("writeHead"));
    (res.end as ReturnType<typeof vi.fn>).mockImplementation(() => order.push("end"));
    sendJson(res, 200, {}); expect(order).toEqual(["writeHead", "end"]);
  });
});
