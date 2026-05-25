/**
 * meatbag-mcp client library — HTTP calls to meatbag-service.
 * All functions are parameterized (no module-level env var reads) for testability.
 */

/**
 * POSTs a question to the service and returns the assigned request_id.
 *
 * @throws if the service is unreachable or returns a non-OK status.
 */
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

/**
 * Long-polls GET /response/:id until an answer arrives or the deadline is exceeded.
 *
 * @param serviceUrl      Base URL of meatbag-service
 * @param requestId       ID returned by postRequest
 * @param maxWaitMs       Total wait budget (default: 5 minutes)
 * @param pollIntervalMs  Delay between retries when server returns empty (default: 2 s)
 */
export async function pollResponse(
  serviceUrl: string,
  requestId: string,
  maxWaitMs = 5 * 60 * 1_000,
  pollIntervalMs = 2_000
): Promise<string> {
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    let res: Response;
    try {
      // GET /response/:id long-polls for up to 30 s on the server side
      res = await fetch(`${serviceUrl}/response/${requestId}`, {
        signal: AbortSignal.timeout(35_000), // 30 s server long-poll + 5 s buffer
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
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  throw new Error("Timed out waiting for human response");
}

/**
 * Convenience: posts the question and polls until an answer arrives.
 */
export async function requestHumanInput(
  serviceUrl: string,
  question: string,
  image_path?: string
): Promise<string> {
  const requestId = await postRequest(serviceUrl, question, image_path);
  return pollResponse(serviceUrl, requestId);
}
