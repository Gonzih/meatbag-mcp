/**
 * Tests for the sequential queue algorithm used in meatbag-service.
 *
 * Implements the same state machine as service.ts in isolation so we can
 * test the queue behavior without HTTP servers, Telegram API calls, or
 * process.exit() at module load time.
 *
 * Invariants under test:
 *  - Only one request is "active" (sent to Telegram) at a time
 *  - Requests are dispatched FIFO
 *  - Answering the active request immediately dispatches the next queued one
 *  - A Telegram send failure releases the active slot and advances the queue
 *  - Waiter callbacks receive the answer string, or null on failure
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Self-contained queue implementation ─────────────────────────────────────
// Mirrors service.ts logic without HTTP/Telegram/process.exit dependencies.

interface RequestEntry {
  id: string;
  question: string;
  context?: string;
  answer?: string;
  failReason?: string;
  waiters: Array<(answer: string | null) => void>;
}

class SequentialQueue {
  private requests = new Map<string, RequestEntry>();
  private sendQueue: string[] = [];
  private activeRequestId: string | null = null;

  constructor(
    private readonly sendFn: (entry: RequestEntry) => Promise<void>
  ) {}

  /** Enqueue a request and kick the dispatcher. */
  enqueue(entry: RequestEntry): void {
    this.requests.set(entry.id, entry);
    this.sendQueue.push(entry.id);
    void this.processQueue();
  }

  /** Simulate a Telegram reply arriving for the active request. */
  receiveAnswer(text: string): void {
    if (this.activeRequestId === null) return;
    const id = this.activeRequestId;
    this.activeRequestId = null;
    const entry = this.requests.get(id);
    if (!entry) {
      void this.processQueue();
      return;
    }
    entry.answer = text;
    for (const w of entry.waiters) w(text);
    entry.waiters = [];
    void this.processQueue();
  }

  get state() {
    return {
      queued: this.sendQueue.length,
      active: this.activeRequestId,
    };
  }

  private async processQueue(): Promise<void> {
    // Re-entrancy guard: if a request is already active, do nothing
    if (this.activeRequestId !== null) return;
    if (this.sendQueue.length === 0) return;

    const id = this.sendQueue.shift()!;
    const entry = this.requests.get(id);
    if (!entry) {
      void this.processQueue();
      return;
    }

    // Claim the active slot BEFORE the first await (prevents concurrent sends)
    this.activeRequestId = id;

    try {
      await this.sendFn(entry);
    } catch (err) {
      // Send failed — release slot, notify waiters, advance queue
      this.activeRequestId = null;
      entry.failReason = err instanceof Error ? err.message : String(err);
      for (const w of entry.waiters) w(null);
      entry.waiters = [];
      void this.processQueue();
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeEntry(id: string, question = "test question"): RequestEntry {
  return { id, question, waiters: [] };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("SequentialQueue", () => {
  let sendFn: ReturnType<typeof vi.fn>;
  let queue: SequentialQueue;

  beforeEach(() => {
    sendFn = vi.fn().mockResolvedValue(undefined);
    queue = new SequentialQueue(sendFn);
  });

  describe("single request", () => {
    it("becomes active immediately after enqueue", async () => {
      const entry = makeEntry("req-1");
      queue.enqueue(entry);

      // Allow the async processQueue to run
      await Promise.resolve();

      expect(queue.state.active).toBe("req-1");
      expect(queue.state.queued).toBe(0);
      expect(sendFn).toHaveBeenCalledOnce();
      expect(sendFn).toHaveBeenCalledWith(entry);
    });

    it("clears active slot after answer", async () => {
      queue.enqueue(makeEntry("req-1"));
      await Promise.resolve();

      queue.receiveAnswer("yes");

      expect(queue.state.active).toBe(null);
      expect(queue.state.queued).toBe(0);
    });

    it("delivers answer to waiters", async () => {
      const entry = makeEntry("req-1");
      const waiterCallback = vi.fn();
      entry.waiters.push(waiterCallback);

      queue.enqueue(entry);
      await Promise.resolve();

      queue.receiveAnswer("approved");

      expect(waiterCallback).toHaveBeenCalledOnce();
      expect(waiterCallback).toHaveBeenCalledWith("approved");
    });
  });

  describe("multiple requests — FIFO ordering", () => {
    it("holds second request in sendQueue while first is active", async () => {
      queue.enqueue(makeEntry("req-1"));
      queue.enqueue(makeEntry("req-2"));

      await Promise.resolve();

      expect(queue.state.active).toBe("req-1");
      expect(queue.state.queued).toBe(1);
      // sendFn called only once — req-2 is still deferred
      expect(sendFn).toHaveBeenCalledOnce();
    });

    it("dispatches second request after first is answered", async () => {
      queue.enqueue(makeEntry("req-1"));
      queue.enqueue(makeEntry("req-2"));

      await Promise.resolve();
      queue.receiveAnswer("done");
      await Promise.resolve();

      expect(queue.state.active).toBe("req-2");
      expect(queue.state.queued).toBe(0);
      expect(sendFn).toHaveBeenCalledTimes(2);
    });

    it("preserves FIFO order for three requests", async () => {
      const order: string[] = [];
      const trackingFn = vi.fn(async (e: RequestEntry) => {
        order.push(e.id);
      });
      queue = new SequentialQueue(trackingFn);

      queue.enqueue(makeEntry("req-1"));
      queue.enqueue(makeEntry("req-2"));
      queue.enqueue(makeEntry("req-3"));

      await Promise.resolve();
      expect(queue.state.active).toBe("req-1");

      queue.receiveAnswer("a");
      await Promise.resolve();
      expect(queue.state.active).toBe("req-2");

      queue.receiveAnswer("b");
      await Promise.resolve();
      expect(queue.state.active).toBe("req-3");

      queue.receiveAnswer("c");
      await Promise.resolve();
      expect(queue.state.active).toBe(null);

      expect(order).toEqual(["req-1", "req-2", "req-3"]);
    });
  });

  describe("send failure handling", () => {
    it("releases active slot on sendFn rejection", async () => {
      const failFn = vi.fn().mockRejectedValue(new Error("Telegram 500"));
      queue = new SequentialQueue(failFn);

      queue.enqueue(makeEntry("req-1"));
      // Wait for the rejected promise to be handled
      await new Promise((r) => setTimeout(r, 0));

      expect(queue.state.active).toBe(null);
    });

    it("calls waiters with null on send failure", async () => {
      const failFn = vi.fn().mockRejectedValue(new Error("network error"));
      queue = new SequentialQueue(failFn);

      const entry = makeEntry("req-1");
      const waiter = vi.fn();
      entry.waiters.push(waiter);

      queue.enqueue(entry);
      await new Promise((r) => setTimeout(r, 0));

      expect(waiter).toHaveBeenCalledWith(null);
    });

    it("records failReason on the entry", async () => {
      const failFn = vi.fn().mockRejectedValue(new Error("timeout"));
      queue = new SequentialQueue(failFn);

      const entry = makeEntry("req-fail");
      queue.enqueue(entry);
      await new Promise((r) => setTimeout(r, 0));

      expect(entry.failReason).toBe("timeout");
    });

    it("dispatches next queued request after a send failure", async () => {
      let callCount = 0;
      const partialFailFn = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) throw new Error("first fails");
        // second succeeds
      });
      queue = new SequentialQueue(partialFailFn);

      queue.enqueue(makeEntry("req-1"));
      queue.enqueue(makeEntry("req-2"));

      await new Promise((r) => setTimeout(r, 0));

      // req-1 failed, req-2 should now be active
      expect(queue.state.active).toBe("req-2");
      expect(queue.state.queued).toBe(0);
    });
  });

  describe("re-entrancy guard", () => {
    it("does not send a second request concurrently with the first", async () => {
      let resolveFirst!: () => void;
      const slowFn = vi.fn().mockReturnValue(
        new Promise<void>((r) => {
          resolveFirst = r;
        })
      );
      queue = new SequentialQueue(slowFn);

      queue.enqueue(makeEntry("req-1"));
      queue.enqueue(makeEntry("req-2"));

      await Promise.resolve();

      // While req-1 is in-flight, calling processQueue again must not start req-2
      expect(slowFn).toHaveBeenCalledOnce();
      expect(queue.state.active).toBe("req-1");
      expect(queue.state.queued).toBe(1);

      resolveFirst();
      queue.receiveAnswer("done");
      await Promise.resolve();

      expect(slowFn).toHaveBeenCalledTimes(2);
    });
  });
});
