// tests/unit/tab-storage.test.ts
// Unit tests for the multi-tab storage helpers.
// Validates per-tab key isolation, accumulation logic, and cleanup behavior.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TabState, SessionCost } from '../../lib/message-types';

// In-memory store mock — simulates chrome.storage.session behavior
function createStoreMock() {
  const store: Record<string, any> = {};
  return {
    get: vi.fn(async (keys: string | string[] | null) => {
      if (keys === null) return { ...store };
      const keyList = typeof keys === 'string' ? [keys] : keys;
      return Object.fromEntries(keyList.map((k) => [k, store[k]]));
    }),
    set: vi.fn(async (items: Record<string, any>) => {
      Object.assign(store, items);
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      const keyList = typeof keys === 'string' ? [keys] : keys;
      keyList.forEach((k) => delete store[k]);
    }),
    _raw: store,
  };
}

// Extracted and testable version of the writeTabState logic from background.ts
async function writeTabState(
  storage: ReturnType<typeof createStoreMock>,
  tabId: number,
  platform: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  stopReason: string | null,
): Promise<void> {
  const stateKey = `tabState_${tabId}`;
  const costKey = `sessionCost_${tabId}`;

  const existing = await storage.get([costKey]);
  const prev: SessionCost = existing[costKey] ?? {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    requestCount: 0,
    updatedAt: 0,
  };

  const now = Date.now();

  const newTabState: TabState = {
    platform,
    model,
    inputTokens,
    outputTokens,
    stopReason,
    updatedAt: now,
  };

  // Only accumulate session totals on STREAM_COMPLETE — not on every TOKEN_BATCH flush.
  const isComplete = stopReason !== null;
  const newCost: SessionCost = isComplete
    ? {
        totalInputTokens: prev.totalInputTokens + inputTokens,
        totalOutputTokens: prev.totalOutputTokens + outputTokens,
        requestCount: prev.requestCount + 1,
        updatedAt: now,
      }
    : { ...prev, updatedAt: now };

  await storage.set({ [stateKey]: newTabState, [costKey]: newCost });
}

describe('tab storage — key isolation', () => {
  let storage: ReturnType<typeof createStoreMock>;

  beforeEach(() => {
    storage = createStoreMock();
  });

  it('writes to isolated keys for tab 1', async () => {
    await writeTabState(storage, 1, 'claude', 'claude-sonnet-4-6', 50, 200, 'end_turn');
    const result = await storage.get(['tabState_1', 'sessionCost_1']);
    expect(result['tabState_1'].inputTokens).toBe(50);
    expect(result['tabState_1'].outputTokens).toBe(200);
    expect(result['tabState_1'].platform).toBe('claude');
    expect(result['sessionCost_1'].totalInputTokens).toBe(50);
    expect(result['sessionCost_1'].requestCount).toBe(1);
  });

  it('does not overwrite tab 2 when writing to tab 1', async () => {
    await writeTabState(storage, 1, 'claude', 'claude-sonnet-4-6', 50, 200, 'end_turn');
    await writeTabState(storage, 2, 'claude', 'claude-sonnet-4-6', 30, 100, 'end_turn');

    const tab1 = await storage.get(['tabState_1']);
    const tab2 = await storage.get(['tabState_2']);

    expect(tab1['tabState_1'].inputTokens).toBe(50);
    expect(tab2['tabState_2'].inputTokens).toBe(30);
  });

  it('accumulates session cost across multiple requests on the same tab', async () => {
    await writeTabState(storage, 1, 'claude', 'claude-sonnet-4-6', 20, 80, 'end_turn');
    await writeTabState(storage, 1, 'claude', 'claude-sonnet-4-6', 15, 60, 'end_turn');

    const result = await storage.get(['sessionCost_1']);
    expect(result['sessionCost_1'].totalInputTokens).toBe(35);
    expect(result['sessionCost_1'].totalOutputTokens).toBe(140);
    expect(result['sessionCost_1'].requestCount).toBe(2);
  });

  it('does not increment requestCount on TOKEN_BATCH (non-final) writes', async () => {
    await writeTabState(storage, 1, 'claude', 'claude-sonnet-4-6', 20, 80, null);

    const result = await storage.get(['sessionCost_1']);
    expect(result['sessionCost_1'].requestCount).toBe(0);
    // SESSION totals must not accumulate on intermediate streaming flushes
    expect(result['sessionCost_1'].totalInputTokens).toBe(0);
    expect(result['sessionCost_1'].totalOutputTokens).toBe(0);
  });

  it('does not double-count when TOKEN_BATCH flushes precede STREAM_COMPLETE', async () => {
    // Simulate 3 intermediate 200ms flushes, then the final stream-complete
    await writeTabState(storage, 1, 'claude', 'claude-sonnet-4-6', 10, 40, null);
    await writeTabState(storage, 1, 'claude', 'claude-sonnet-4-6', 20, 80, null);
    await writeTabState(storage, 1, 'claude', 'claude-sonnet-4-6', 25, 100, null);
    await writeTabState(storage, 1, 'claude', 'claude-sonnet-4-6', 25, 100, 'end_turn');

    const result = await storage.get(['sessionCost_1']);
    // Only the final STREAM_COMPLETE tokens should be accumulated
    expect(result['sessionCost_1'].totalInputTokens).toBe(25);
    expect(result['sessionCost_1'].totalOutputTokens).toBe(100);
    expect(result['sessionCost_1'].requestCount).toBe(1);
  });
});

describe('tab storage — cleanup', () => {
  it('removes only the closed tab keys', async () => {
    const storage = createStoreMock();
    await writeTabState(storage, 10, 'claude', 'claude-sonnet-4-6', 50, 200, 'end_turn');
    await writeTabState(storage, 20, 'claude', 'claude-sonnet-4-6', 30, 100, 'end_turn');

    // Simulate tab 10 closing
    await storage.remove(['tabState_10', 'sessionCost_10']);

    const remaining = await storage.get(null);
    expect(Object.keys(remaining)).not.toContain('tabState_10');
    expect(Object.keys(remaining)).not.toContain('sessionCost_10');
    expect(Object.keys(remaining)).toContain('tabState_20');
    expect(Object.keys(remaining)).toContain('sessionCost_20');
  });

  it('orphan cleanup removes keys for non-existent tabs', async () => {
    const storage = createStoreMock();
    await writeTabState(storage, 99, 'claude', 'claude-sonnet-4-6', 10, 40, 'end_turn');

    // Simulate orphan cleanup: tab 99 no longer exists in allTabs
    const allData = await storage.get(null);
    const activeTabs = new Set(['50', '51']); // tab 99 is not active
    const orphanKeys = Object.keys(allData).filter((key) => {
      const match = key.match(/^(?:tabState|sessionCost)_(\d+)$/);
      return match && !activeTabs.has(match[1]);
    });

    await storage.remove(orphanKeys);

    const remaining = await storage.get(null);
    expect(Object.keys(remaining)).not.toContain('tabState_99');
    expect(Object.keys(remaining)).not.toContain('sessionCost_99');
  });
});
