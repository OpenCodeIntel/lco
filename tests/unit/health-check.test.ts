// tests/unit/health-check.test.ts
// Unit tests for the SSE lifecycle health check state machine.
// Mirrors the health detection logic from entrypoints/inject.ts so it can
// run in Node without a browser runtime. No changes to production code.

import { describe, it, expect } from 'vitest';

// -- Mirrored types --

interface HealthState {
  chunksProcessed: number;
  sawMessageStart: boolean;
  sawContentBlock: boolean;
  sawStreamEnd: boolean;
  stopReason: string | null;
}

type HealthBrokenReason = 'missing_sentinel' | 'stream_timeout' | 'incomplete_lifecycle';

type HealthVerdict =
  | { broken: true; reason: HealthBrokenReason; message: string }
  | { broken: false; recovered: boolean };

/**
 * Mirrors the post-stream health decision block from inject.ts (finally clause).
 * Returns the verdict that inject.ts would post via the secure bridge.
 *
 * @param health       Final health state after the stream loop exits.
 * @param prevFailed   Whether the previous stream for this page load failed.
 * @param brokenAlreadyFired Whether a HEALTH_BROKEN was already posted mid-stream
 *                           (e.g. by the watchdog), which suppresses the end-of-stream check.
 */
function evaluateStreamHealth(
  health: HealthState,
  prevFailed: boolean,
  brokenAlreadyFired: boolean,
): HealthVerdict {
  if (!brokenAlreadyFired) {
    if (!health.sawMessageStart && health.chunksProcessed >= 10) {
      return {
        broken: true,
        reason: 'missing_sentinel',
        message: `${health.chunksProcessed} chunks processed but stream_start event never arrived.`,
      };
    }
    if (health.sawMessageStart && !health.sawStreamEnd) {
      return {
        broken: true,
        reason: 'incomplete_lifecycle',
        message: 'Stream started but stream_end event never arrived.',
      };
    }
  }

  // Stream was clean (or broken was already reported mid-stream).
  const nowFailed = brokenAlreadyFired;
  if (!nowFailed && prevFailed) {
    return { broken: false, recovered: true };
  }
  return { broken: false, recovered: false };
}

/**
 * Mirrors the watchdog health verdict: fires when the stream is silent for 120s.
 * Returns the verdict that the watchdog interval would post.
 */
function evaluateWatchdogTimeout(
  lastDataTime: number,
  nowMs: number,
): { timedOut: boolean } {
  return { timedOut: nowMs - lastDataTime > 120_000 };
}

function makeHealth(overrides: Partial<HealthState> = {}): HealthState {
  return {
    chunksProcessed: 0,
    sawMessageStart: false,
    sawContentBlock: false,
    sawStreamEnd: false,
    stopReason: null,
    ...overrides,
  };
}

// ---

describe('missing_sentinel detection', () => {
  it('fires HEALTH_BROKEN when 10+ chunks arrive without message_start', () => {
    const health = makeHealth({ chunksProcessed: 10, sawMessageStart: false });
    const verdict = evaluateStreamHealth(health, false, false);
    expect(verdict.broken).toBe(true);
    if (verdict.broken) {
      expect(verdict.reason).toBe('missing_sentinel');
    }
  });

  it('fires HEALTH_BROKEN at exactly 10 chunks (boundary)', () => {
    const health = makeHealth({ chunksProcessed: 10 });
    const verdict = evaluateStreamHealth(health, false, false);
    expect(verdict.broken).toBe(true);
  });

  it('fires HEALTH_BROKEN at many chunks without message_start', () => {
    const health = makeHealth({ chunksProcessed: 250, sawMessageStart: false });
    const verdict = evaluateStreamHealth(health, false, false);
    expect(verdict.broken).toBe(true);
    if (verdict.broken) {
      expect(verdict.reason).toBe('missing_sentinel');
      expect(verdict.message).toContain('250');
    }
  });

  it('does NOT fire HEALTH_BROKEN for fewer than 10 chunks (short clean response)', () => {
    const health = makeHealth({ chunksProcessed: 9, sawMessageStart: false });
    const verdict = evaluateStreamHealth(health, false, false);
    expect(verdict.broken).toBe(false);
  });

  it('does NOT fire HEALTH_BROKEN when message_start was seen', () => {
    const health = makeHealth({
      chunksProcessed: 15,
      sawMessageStart: true,
      sawStreamEnd: true,
    });
    const verdict = evaluateStreamHealth(health, false, false);
    expect(verdict.broken).toBe(false);
  });
});

describe('incomplete_lifecycle detection', () => {
  it('fires HEALTH_BROKEN when message_start arrived but message_stop never did', () => {
    const health = makeHealth({ chunksProcessed: 5, sawMessageStart: true, sawStreamEnd: false });
    const verdict = evaluateStreamHealth(health, false, false);
    expect(verdict.broken).toBe(true);
    if (verdict.broken) {
      expect(verdict.reason).toBe('incomplete_lifecycle');
    }
  });

  it('does NOT fire when both message_start and message_stop were seen', () => {
    const health = makeHealth({
      chunksProcessed: 20,
      sawMessageStart: true,
      sawStreamEnd: true,
    });
    const verdict = evaluateStreamHealth(health, false, false);
    expect(verdict.broken).toBe(false);
  });

  it('incomplete_lifecycle message is descriptive', () => {
    const health = makeHealth({ chunksProcessed: 5, sawMessageStart: true, sawStreamEnd: false });
    const verdict = evaluateStreamHealth(health, false, false);
    if (verdict.broken) {
      expect(verdict.message).toContain('stream_end');
    }
  });
});

describe('watchdog timeout', () => {
  it('detects silence after 120s', () => {
    const lastDataTime = Date.now() - 121_000;
    const { timedOut } = evaluateWatchdogTimeout(lastDataTime, Date.now());
    expect(timedOut).toBe(true);
  });

  it('does not trigger before 120s', () => {
    const lastDataTime = Date.now() - 119_000;
    const { timedOut } = evaluateWatchdogTimeout(lastDataTime, Date.now());
    expect(timedOut).toBe(false);
  });

  it('does not trigger at exactly 120s (boundary is exclusive)', () => {
    const lastDataTime = Date.now() - 120_000;
    const { timedOut } = evaluateWatchdogTimeout(lastDataTime, Date.now());
    // 120_000 > 120_000 is false — watchdog triggers only after strictly more than 120s
    expect(timedOut).toBe(false);
  });

  it('triggers for very long silences', () => {
    const lastDataTime = Date.now() - 600_000; // 10 minutes
    const { timedOut } = evaluateWatchdogTimeout(lastDataTime, Date.now());
    expect(timedOut).toBe(true);
  });
});

describe('brokenAlreadyFired guard', () => {
  it('suppresses end-of-stream check when watchdog already fired', () => {
    // Simulate: stream was silent for 120s (watchdog fired), then reader cancel completed.
    // Health state looks like missing_sentinel but the watchdog already reported it.
    const health = makeHealth({ chunksProcessed: 50, sawMessageStart: false });
    const verdict = evaluateStreamHealth(health, false, true /* already fired */);
    expect(verdict.broken).toBe(false);
  });

  it('suppresses incomplete_lifecycle when watchdog already fired', () => {
    const health = makeHealth({ chunksProcessed: 5, sawMessageStart: true, sawStreamEnd: false });
    const verdict = evaluateStreamHealth(health, false, true);
    expect(verdict.broken).toBe(false);
  });
});

describe('HEALTH_RECOVERED', () => {
  it('signals recovery after a clean stream following a failed one', () => {
    const health = makeHealth({ chunksProcessed: 10, sawMessageStart: true, sawStreamEnd: true });
    const verdict = evaluateStreamHealth(health, true /* prevFailed */, false);
    expect(verdict.broken).toBe(false);
    if (!verdict.broken) {
      expect(verdict.recovered).toBe(true);
    }
  });

  it('does NOT signal recovery when the previous stream was clean', () => {
    const health = makeHealth({ chunksProcessed: 10, sawMessageStart: true, sawStreamEnd: true });
    const verdict = evaluateStreamHealth(health, false /* prevFailed */, false);
    expect(verdict.broken).toBe(false);
    if (!verdict.broken) {
      expect(verdict.recovered).toBe(false);
    }
  });

  it('does NOT signal recovery when the current stream also fails', () => {
    // Both previous and current failed — no recovery yet.
    const health = makeHealth({ chunksProcessed: 15, sawMessageStart: false });
    const verdict = evaluateStreamHealth(health, true /* prevFailed */, false);
    // Current stream has missing_sentinel — still broken, no recovery.
    expect(verdict.broken).toBe(true);
  });

  it('does NOT signal recovery when brokenAlreadyFired (watchdog) and prevFailed was true', () => {
    // The watchdog fired mid-stream AND the previous stream also failed.
    // No recovery — the current stream itself is broken.
    const health = makeHealth({ chunksProcessed: 50, sawMessageStart: false });
    const verdict = evaluateStreamHealth(health, true /* prevFailed */, true /* alreadyFired */);
    expect(verdict.broken).toBe(false);
    if (!verdict.broken) {
      // brokenAlreadyFired means nowFailed = true, so !nowFailed is false — no recovery
      expect(verdict.recovered).toBe(false);
    }
  });
});

describe('normal stream — no warnings', () => {
  it('is clean for a typical short response', () => {
    const health = makeHealth({
      chunksProcessed: 5,
      sawMessageStart: true,
      sawStreamEnd: true,
      stopReason: 'end_turn',
    });
    const verdict = evaluateStreamHealth(health, false, false);
    expect(verdict.broken).toBe(false);
    if (!verdict.broken) {
      expect(verdict.recovered).toBe(false);
    }
  });

  it('is clean for a typical long response', () => {
    const health = makeHealth({
      chunksProcessed: 500,
      sawMessageStart: true,
      sawStreamEnd: true,
      stopReason: 'max_tokens',
    });
    const verdict = evaluateStreamHealth(health, false, false);
    expect(verdict.broken).toBe(false);
  });

  it('is clean for an empty stream (zero chunks)', () => {
    // If zero chunks arrive, the connection may have opened and closed.
    // This is not a health failure — no chunks means chunksProcessed < 10.
    const health = makeHealth({ chunksProcessed: 0 });
    const verdict = evaluateStreamHealth(health, false, false);
    expect(verdict.broken).toBe(false);
  });
});
