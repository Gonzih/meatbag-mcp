/**
 * mcp-core.ts — service client helpers
 *
 * Exported functions with no module-level side effects.
 * Imported by mcp.ts (the entry-point) and by tests.
 */

export const POLL_INTERVAL_MS = 2_000;
export const DEFAULT_MAX_WAIT_MS = 5 * 60 * 1_000; // 5 minutes

export async function postRequest(
  serviceUrl: string,
  question: string,
  image_path?: string
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${serviceUrl}/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, image_path }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `meatbag-service is not running on ${serviceUrl}: ${msg}\n` +
        `Start it with: MEATBAG_BOT_TOKEN=<token> MEATBAG_CHAT_ID=<id> meatbag-service`
    );
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`POST ${serviceUrl}/request failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as { request_id?: string; error?: string };
  if (!data.request_id) {
    throw new Error(`Service returned no request_id: ${JSON.stringify(data)}`);
  }
  return data.request_id;
}

export async function pollResponse(
  serviceUrl: string,
  requestId: string,
  maxWaitMs = DEFAULT_MAX_WAIT_MS
): Promise<string> {
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    let res: Response;
    try {
      // GET /response/:id long-polls for up to 30s on the server side
      res = await fetch(`${serviceUrl}/response/${requestId}`, {
        signal: AbortSignal.timeout(35_000), // 30s server long-poll + 5s buffer
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`GET ${serviceUrl}/response/${requestId} failed: ${msg}`);
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
