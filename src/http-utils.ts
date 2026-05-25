import { IncomingMessage, ServerResponse } from "http";

/**
 * Reads the full body of an HTTP request as a UTF-8 string.
 */
export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

/**
 * Writes a JSON response with the given HTTP status code.
 * No-ops if the response is already finished.
 */
export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}
