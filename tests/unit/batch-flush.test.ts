// tests/unit/batch-flush.test.ts
// Unit tests for the 200ms batch flush debounce behavior.
// Mirrors the scheduleBatchFlush / flushTimer pattern from entrypoints/inject.ts.
// Uses vitest fake timers to control time deterministically.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// -- Mirrored batch flusher --
//
// The production code in inject.ts uses a module-scoped setTimeout with a
// closure over `summary`. This test extracts that pattern into a factory so
// it can be instantiated per-test without shared state.

interface TokenSummary {
  inputTokens: number;
  outputTokens: number;
  model: string;
}

interface BatchFlusher {
  /** Schedule a flush in 200ms. No-ops if one is already scheduled. */
  schedule(): void;
  /** Cancel any pending flush. Typically called before STREAM_COMPLETE. */
  cancel(): void;
  /** True if a flush is currently scheduled. */
  readonly pending: boolean;
}

function createBatchFlusher(
  summary: TokenSummary,
  onFlush: (snapshot: TokenSummary) => void,
  delayMs = 200,
): BatchFlusher {
  let timer: ReturnType<typeof setTimeout> | null = null;

  return {
    schedule() {
      if (timer !== null) return; // already scheduled — idempotent
      timer = setTimeout(() => {
        timer = null;
        onFlush({ ...summary });
      }, delayMs);
    },
    cancel() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
    get pending() {
      return timer !== null;
    },
  };
}

// ---

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('200ms debounce — scheduling', () => {
  it('schedules a flush on the first call', () => {
    const onFlush = vi.fn();
    const summary: TokenSummary = { inputTokens: 10, outputTokens: 50, model: 'claude-sonnet-4-6' };
    const flusher = createBatchFlusher(summary, onFlush);

    flusher.schedule();
    expect(flusher.pending).toBe(true);
    expect(onFlush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(200);
    expect(onFlush).toHaveBeenCalledOnce();
    expect(flusher.pending).toBe(false);
  });

  it('is idempotent: multiple schedule() calls within 200ms produce one flush', () => {
    const onFlush = vi.fn();
    const summary: TokenSummary = { inputTokens: 10, outputTokens: 50, model: 'claude-sonnet-4-6' };
    const flusher = createBatchFlusher(summary, onFlush);

    flusher.schedule();
    vi.advanceTimersByTime(50);
    flusher.schedule();
    vi.advanceTimersByTime(50);
    flusher.schedule();
    vi.advanceTimersByTime(100);

    expect(onFlush).toHaveBeenCalledOnce();
  });

  it('flushes with the token values current at fire time', () => {
    let flushed: TokenSummary | null = null;
    const summary: TokenSummary = { inputTokens: 0, outputTokens: 0, model: 'claude-sonnet-4-6' };
    const flusher = createBatchFlusher(summary, (s) => { flushed = s; });

    flusher.schedule();
    // Simulate tokens accumulating between schedule() and the flush firing.
    summary.inputTokens = 50;
    summary.outputTokens = 200;
    vi.advanceTimersByTime(200);

    expect(flushed).not.toBeNull();
    expect(flushed!.inputTokens).toBe(50);
    expect(flushed!.outputTokens).toBe(200);
  });

  it('schedules a new flush after a previous one fires', () => {
    const onFlush = vi.fn();
    const summary: TokenSummary = { inputTokens: 0, outputTokens: 0, model: 'claude-sonnet-4-6' };
    const flusher = createBatchFlusher(summary, onFlush);

    // First window
    flusher.schedule();
    vi.advanceTimersByTime(200);
    expect(onFlush).toHaveBeenCalledTimes(1);

    // Second window — should be independent
    flusher.schedule();
    vi.advanceTimersByTime(200);
    expect(onFlush).toHaveBeenCalledTimes(2);
  });
});

describe('200ms debounce — cancellation', () => {
  it('cancel() prevents the flush from firing', () => {
    const onFlush = vi.fn();
    const summary: TokenSummary = { inputTokens: 10, outputTokens: 30, model: 'claude-sonnet-4-6' };
    const flusher = createBatchFlusher(summary, onFlush);

    flusher.schedule();
    expect(flusher.pending).toBe(true);
    flusher.cancel();
    expect(flusher.pending).toBe(false);

    vi.advanceTimersByTime(200);
    expect(onFlush).not.toHaveBeenCalled();
  });

  it('cancel() is a no-op when nothing is scheduled', () => {
    const onFlush = vi.fn();
    const summary: TokenSummary = { inputTokens: 0, outputTokens: 0, model: 'claude-sonnet-4-6' };
    const flusher = createBatchFlusher(summary, onFlush);

    // No exception should be thrown
    expect(() => flusher.cancel()).not.toThrow();
    vi.advanceTimersByTime(200);
    expect(onFlush).not.toHaveBeenCalled();
  });

  it('allows rescheduling after a cancel', () => {
    const onFlush = vi.fn();
    const summary: TokenSummary = { inputTokens: 5, outputTokens: 20, model: 'claude-sonnet-4-6' };
    const flusher = createBatchFlusher(summary, onFlush);

    flusher.schedule();
    vi.advanceTimersByTime(50);
    flusher.cancel();

    // A new schedule() after cancel should work normally.
    flusher.schedule();
    vi.advanceTimersByTime(200);
    expect(onFlush).toHaveBeenCalledOnce();
  });
});

describe('stream-end behavior: cancel then send STREAM_COMPLETE', () => {
  it('cancel + immediate STREAM_COMPLETE delivers exactly one final event', () => {
    const batches: TokenSummary[] = [];
    const summary: TokenSummary = { inputTokens: 43, outputTokens: 385, model: 'claude-sonnet-4-6' };
    const flusher = createBatchFlusher(summary, (s) => batches.push(s));

    // Mid-stream batch is scheduled
    flusher.schedule();
    vi.advanceTimersByTime(100); // flush hasn't fired yet

    // Stream ends: cancel pending batch, then emit final STREAM_COMPLETE
    flusher.cancel();
    // Simulate final STREAM_COMPLETE being sent directly (not via flusher)
    batches.push({ ...summary, inputTokens: 57, outputTokens: 511 });

    vi.advanceTimersByTime(200); // should not trigger an extra flush

    expect(batches).toHaveLength(1);
    expect(batches[0].inputTokens).toBe(57);
    expect(batches[0].outputTokens).toBe(511);
  });

  it('no-op cancel before stream-end does not affect STREAM_COMPLETE', () => {
    const batches: TokenSummary[] = [];
    const summary: TokenSummary = { inputTokens: 10, outputTokens: 20, model: 'claude-haiku-4-5' };
    const flusher = createBatchFlusher(summary, (s) => batches.push(s));

    // Stream completes with no mid-stream batch scheduled.
    flusher.cancel(); // should be a no-op
    batches.push({ ...summary });

    expect(batches).toHaveLength(1);
  });
});

describe('flush payload isolation', () => {
  it('each flush receives a snapshot, not a live reference', () => {
    const snapshots: TokenSummary[] = [];
    const summary: TokenSummary = { inputTokens: 0, outputTokens: 0, model: 'claude-sonnet-4-6' };
    const flusher = createBatchFlusher(summary, (s) => snapshots.push(s));

    flusher.schedule();
    summary.outputTokens = 100;
    vi.advanceTimersByTime(200);

    // Mutate summary after flush — snapshot must not change.
    summary.outputTokens = 9999;

    expect(snapshots[0].outputTokens).toBe(100); // snapshot, not live
    expect(snapshots[0].outputTokens).not.toBe(9999);
  });
});
