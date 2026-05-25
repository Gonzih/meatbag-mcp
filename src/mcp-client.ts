/**
 * mcp-client — pure HTTP client for meatbag-service
 *
 * Contains only the service-communication logic used by meatbag-mcp.
 * No MCP SDK imports, no stdio, no process.exit — safe to import in tests.
 */

// ── Config ───────────────────────────────────────────────────────────────────

export const SERVICE_URL = process.env.MEATBAG_SERVICE_URL ?? "http://localhost:7702";
export const POLL_INTERVAL_MS = 2_000;
export const MAX_WAIT_MS = 5 * 60 * 1_000; // 5 minutes total

// ── Service client ────────────────────────────────────────────────────────────

/**
 * Submit a question to meatbag-service and return the assigned request_id.
 * Throws if the service is unreachable or returns an error response.
 */
export async function postRequest(
  question: string,
  image_path?: string
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${SERVICE_URL}/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, image_path }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `meatbag-service is not running on ${SERVICE_URL}: ${msg}\n` +
        `Start it with: MEATBAG_BOT_TOKEN=<token> MEATBAG_CHAT_ID=<id> meatbag-service`
    );
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`POST ${SERVICE_URL}/request failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as { request_id?: string; error?: string };
  if (!data.request_id) {
    throw new Error(`Service returned no request_id: ${JSON.stringify(data)}`);
  }
  return data.request_id;
}

/**
 * Long-poll meatbag-service for an answer to the given request_id.
 * Retries until an answer arrives or MAX_WAIT_MS elapses.
 * Throws on network errors, non-ok HTTP responses, or timeout.
 */
export async function pollResponse(requestId: string): Promise<string> {
  const deadline = Date.now() + MAX_WAIT_MS;

  while (Date.now() < deadline) {
    let res: Response;
    try {
      res = await fetch(`${SERVICE_URL}/response/${requestId}`, {
        signal: AbortSignal.timeout(35_000), // 30s server long-poll + 5s buffer
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`GET ${SERVICE_URL}/response/${requestId} failed: ${msg}`);
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GET /response/${requestId} returned ${res.status}: ${body}`);
    }

    const data = (await res.json()) as { answer?: string };
    if (data.answer !== undefined) {
      return data.answer;
    }

    // Server timed out with no answer — wait briefly and retry
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  throw new Error("Timed out waiting for human response (5 minutes)");
}

/**
 * Convenience wrapper: submit question, then poll for the answer.
 */
export async function requestHumanInput(
  question: string,
  image_path?: string
): Promise<string> {
  const requestId = await postRequest(question, image_path);
  return pollResponse(requestId);
}
