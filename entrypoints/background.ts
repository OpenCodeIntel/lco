// entrypoints/background.ts - Service Worker Engine (Room 3)
// Responsible for: BPE token counting, session storage writes, and tab lifecycle cleanup.
// MV3 requirement: ALL listeners must be registered synchronously at the top level.

import { Tiktoken } from 'js-tiktoken/lite';
import claudeJson from '@anthropic-ai/tokenizer/claude.json';
import type { BackgroundMessage, TabState, SessionCost } from '../lib/message-types';
import { calculateCost } from '../lib/pricing';

let _tokenizer: Tiktoken | null = null;
let _initPromise: Promise<Tiktoken> | null = null;

// Initialize the tokenizer with Anthropic's BPE vocabulary
async function initTokenizer(): Promise<Tiktoken> {
  if (_tokenizer) return _tokenizer;

  const t0 = performance.now();
  _tokenizer = new Tiktoken({
    bpe_ranks: claudeJson.bpe_ranks,
    special_tokens: claudeJson.special_tokens,
    pat_str: claudeJson.pat_str,
  });
  const elapsed = performance.now() - t0;
  console.log(`[LCO] Tokenizer cold start: ${elapsed.toFixed(0)}ms`);

  return _tokenizer;
}

// Preload Pattern: Fire initialization at the top level so it is ready by the
// time the worker handles the first message.
_initPromise = initTokenizer();

// Storage Helpers

/** Build the per-tab storage key for token state */
function tabStateKey(tabId: number): string {
  return `tabState_${tabId}`;
}

/** Build the per-tab storage key for the running session cost accumulator */
function sessionCostKey(tabId: number): string {
  return `sessionCost_${tabId}`;
}

/**
 * Write updated token counts for a given tab into chrome.storage.session.
 * Session cost is only accumulated on STREAM_COMPLETE (stopReason !== null)
 * to avoid double-counting the per-200ms TOKEN_BATCH intermediate flushes.
 */
async function writeTabState(
  tabId: number,
  platform: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  stopReason: string | null,
): Promise<{ tabState: TabState; sessionCost: SessionCost }> {
  const stateKey = tabStateKey(tabId);
  const costKey = sessionCostKey(tabId);

  const existing = await browser.storage.session.get([costKey]);
  const prev: SessionCost = (existing[costKey] as SessionCost | undefined) ?? {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    requestCount: 0,
    updatedAt: 0,
  };

  const now = Date.now();
  const isComplete = stopReason !== null;

  const newTabState: TabState = {
    platform,
    model,
    inputTokens,
    outputTokens,
    stopReason,
    updatedAt: now,
  };

  // Only accumulate session totals on STREAM_COMPLETE — not on every 200ms TOKEN_BATCH flush.
  const thisCost = isComplete ? calculateCost(inputTokens, outputTokens, model) : null;
  const newCost: SessionCost = isComplete
    ? {
        totalInputTokens: prev.totalInputTokens + inputTokens,
        totalOutputTokens: prev.totalOutputTokens + outputTokens,
        requestCount: prev.requestCount + 1,
        estimatedCost:
          thisCost !== null ? (prev.estimatedCost ?? 0) + thisCost : prev.estimatedCost,
        updatedAt: now,
      }
    : { ...prev, updatedAt: now };

  await browser.storage.session.set({
    [stateKey]: newTabState,
    [costKey]: newCost,
  });

  return { tabState: newTabState, sessionCost: newCost };
}

/**
 * Persist the message limit utilization into the current tabState snapshot.
 * Returns the updated TabState, or null if no state exists yet for this tab.
 */
async function writeMessageLimit(
  tabId: number,
  messageLimitUtilization: number,
): Promise<TabState | null> {
  const stateKey = tabStateKey(tabId);
  const existing = await browser.storage.session.get([stateKey]);
  const prev = existing[stateKey] as TabState | undefined;
  if (!prev) return null;
  const updated: TabState = { ...prev, messageLimitUtilization, updatedAt: Date.now() };
  await browser.storage.session.set({ [stateKey]: updated });
  return updated;
}

/** Remove all storage keys associated with a specific tab */
async function cleanTabStorage(tabId: number): Promise<void> {
  await browser.storage.session.remove([tabStateKey(tabId), sessionCostKey(tabId)]);
  console.log(`[LCO] Cleaned storage for closed tab: ${tabId}`);
}

/** Remove keys for tabs that no longer exist (orphan cleanup) */
async function cleanOrphanedTabs(): Promise<void> {
  const [allData, allTabs] = await Promise.all([
    browser.storage.session.get(null),
    browser.tabs.query({}),
  ]);

  const activeIds = new Set(allTabs.map((t) => String(t.id)));
  const orphanKeys = Object.keys(allData).filter((key) => {
    const match = key.match(/^(?:tabState|sessionCost)_(\d+)$/);
    return match && !activeIds.has(match[1]);
  });

  if (orphanKeys.length > 0) {
    await browser.storage.session.remove(orphanKeys);
    console.log(`[LCO] Removed ${orphanKeys.length} orphaned storage keys`);
  }
}

export default defineBackground({
  type: 'module',
  main: () => {
    console.log('[LCO] Service worker booted; pure-JS tokenizer preloading in background.');

    // Handle all incoming messages from Room 2 (content scripts)
    // Note: return true inside any branch that uses sendResponse asynchronously.
    browser.runtime.onMessage.addListener((message: BackgroundMessage, sender, sendResponse) => {
      // BPE estimation requests from the inline token counter bridge
      if (message.type === 'COUNT_TOKENS') {
        _initPromise
          ?.then((tok) => {
            const count = tok.encode(message.text).length;
            sendResponse({ count });
          })
          .catch((err) => {
            console.error('[LCO-ERROR] Tokenizer failed to encode text:', err);
            sendResponse({ count: 0 });
          });
        return true; // Keep channel open for async response
      }

      // Token batch storage from the secure LCO_V1 bridge.
      // Returns { ok, tabState, sessionCost } so the content script can update the overlay
      // with authoritative storage values rather than in-memory estimates.
      if (message.type === 'STORE_TOKEN_BATCH') {
        const tabId = sender.tab?.id;
        if (tabId === undefined) {
          console.warn('[LCO] STORE_TOKEN_BATCH received without a tab ID — ignoring');
          sendResponse({ ok: false });
          return true;
        }

        // Platform attribution from sender.url (set by Chrome, cannot be spoofed)
        const platform =
          sender.url?.includes('claude.ai')
            ? 'claude'
            : sender.url?.includes('chat.openai.com')
              ? 'chatgpt'
              : message.platform;

        writeTabState(
          tabId,
          platform,
          message.model,
          message.inputTokens,
          message.outputTokens,
          message.stopReason,
        )
          .then(({ tabState, sessionCost }) => sendResponse({ ok: true, tabState, sessionCost }))
          .catch((err) => {
            console.error('[LCO-ERROR] Failed to write tab state to storage:', err);
            sendResponse({ ok: false });
          });

        return true; // Keep channel open for async response
      }

      // Message limit utilization from the SSE message_limit event
      if (message.type === 'STORE_MESSAGE_LIMIT') {
        const tabId = sender.tab?.id;
        if (tabId === undefined) {
          sendResponse({ ok: false });
          return true;
        }

        writeMessageLimit(tabId, message.messageLimitUtilization)
          .then((tabState) => sendResponse({ ok: true, tabState }))
          .catch((err) => {
            console.error('[LCO-ERROR] Failed to write message limit to storage:', err);
            sendResponse({ ok: false });
          });

        return true;
      }
    });

    // Tab cleanup: remove storage keys when a tab is closed
    browser.tabs.onRemoved.addListener((tabId) => {
      cleanTabStorage(tabId).catch((err) => {
        console.error(`[LCO-ERROR] Tab cleanup failed for tab ${tabId}:`, err);
      });
    });

    // Periodic orphan cleanup via alarms (setInterval is unreliable in service workers)
    browser.alarms.create('cleanOrphanedTabs', { periodInMinutes: 5 });
    browser.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name !== 'cleanOrphanedTabs') return;
      cleanOrphanedTabs().catch((err) => {
        console.error('[LCO-ERROR] Orphan cleanup failed:', err);
      });
    });
  },
});
