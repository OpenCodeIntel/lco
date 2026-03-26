// tests/integration/ipc-pipeline.test.ts
// Integration tests for the full Room 1 -> Room 2 -> Room 3 IPC pipeline.
// Validates that validated bridge messages are forwarded correctly, and that
// invalid messages (wrong namespace, wrong token, bad schema) are silently dropped.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MockedFunction } from 'vitest';
import { LCO_NAMESPACE } from '../../lib/message-types';
import type { StoreTokenBatchMessage } from '../../lib/message-types';
type StoreMock = MockedFunction<(msg: StoreTokenBatchMessage) => void>;

// -- Shared Bridge Schema Validator (mirrored from content script) --
function isValidBridgeSchema(data: any): boolean {
  if (typeof data !== 'object' || data === null) return false;
  if (data.namespace !== LCO_NAMESPACE) return false;
  if (typeof data.token !== 'string' || data.token.length === 0) return false;
  if (!['TOKEN_BATCH', 'STREAM_COMPLETE', 'HEALTH_BROKEN', 'HEALTH_RECOVERED', 'MESSAGE_LIMIT_UPDATE'].includes(data.type)) return false;
  if (data.type === 'MESSAGE_LIMIT_UPDATE') {
    if (typeof data.messageLimitUtilization !== 'number') return false;
  } else if (data.type === 'HEALTH_BROKEN') {
    if (typeof data.message !== 'string') return false;
  } else if (data.type === 'HEALTH_RECOVERED') {
    if (typeof data.recoveredAt !== 'number') return false;
  } else {
    if (typeof data.inputTokens !== 'number') return false;
    if (typeof data.outputTokens !== 'number') return false;
    if (typeof data.model !== 'string') return false;
  }
  return true;
}

// -- Simulated message bridge: Room 2 validation + Room 3 dispatch --
function createBridge(sessionToken: string, onStoreMessage: (msg: StoreTokenBatchMessage) => void) {
  return function handleMessage(event: { origin: string; data: any }) {
    // Layer 1: origin check
    const pageOrigin = 'https://claude.ai';
    if (event.origin !== pageOrigin) return;

    // Layer 3: namespace
    if (!event.data || event.data.namespace !== LCO_NAMESPACE) return;

    // Layer 4: session token
    if (event.data.token !== sessionToken) return;

    // Layer 5: schema
    if (!isValidBridgeSchema(event.data)) return;

    const msg = event.data;
    if (msg.type === 'TOKEN_BATCH' || msg.type === 'STREAM_COMPLETE') {
      const storageMessage: StoreTokenBatchMessage = {
        type: 'STORE_TOKEN_BATCH',
        platform: msg.platform,
        model: msg.model ?? 'unknown',
        inputTokens: msg.inputTokens ?? 0,
        outputTokens: msg.outputTokens ?? 0,
        stopReason: msg.type === 'STREAM_COMPLETE' ? (msg.stopReason ?? null) : null,
      };
      onStoreMessage(storageMessage);
    }
  };
}

describe('IPC pipeline — valid messages forwarded', () => {
  const sessionToken = crypto.randomUUID();
  let onStore: StoreMock;
  let bridge: ReturnType<typeof createBridge>;

  beforeEach(() => {
    onStore = vi.fn() as StoreMock;
    bridge = createBridge(sessionToken, onStore);
  });

  it('forwards a valid TOKEN_BATCH message to Room 3', () => {
    bridge({
      origin: 'https://claude.ai',
      data: {
        namespace: LCO_NAMESPACE,
        token: sessionToken,
        type: 'TOKEN_BATCH',
        platform: 'claude',
        inputTokens: 43,
        outputTokens: 385,
        model: 'claude-sonnet-4-6',
      },
    });

    expect(onStore).toHaveBeenCalledOnce();
    const forwarded = onStore.mock.calls[0][0] as StoreTokenBatchMessage;
    expect(forwarded.type).toBe('STORE_TOKEN_BATCH');
    expect(forwarded.inputTokens).toBe(43);
    expect(forwarded.outputTokens).toBe(385);
    expect(forwarded.model).toBe('claude-sonnet-4-6');
    expect(forwarded.stopReason).toBeNull(); // TOKEN_BATCH has no stop reason
  });

  it('forwards a STREAM_COMPLETE message with stop reason', () => {
    bridge({
      origin: 'https://claude.ai',
      data: {
        namespace: LCO_NAMESPACE,
        token: sessionToken,
        type: 'STREAM_COMPLETE',
        platform: 'claude',
        inputTokens: 57,
        outputTokens: 511,
        model: 'claude-sonnet-4-6',
        stopReason: 'end_turn',
      },
    });

    expect(onStore).toHaveBeenCalledOnce();
    const forwarded = onStore.mock.calls[0][0] as StoreTokenBatchMessage;
    expect(forwarded.stopReason).toBe('end_turn');
  });
});

describe('IPC pipeline — invalid messages dropped', () => {
  const sessionToken = crypto.randomUUID();
  let onStore: StoreMock;
  let bridge: ReturnType<typeof createBridge>;

  beforeEach(() => {
    onStore = vi.fn() as StoreMock;
    bridge = createBridge(sessionToken, onStore);
  });

  it('drops messages from a different origin (Layer 1)', () => {
    bridge({
      origin: 'https://evil.com',
      data: {
        namespace: LCO_NAMESPACE,
        token: sessionToken,
        type: 'TOKEN_BATCH',
        platform: 'claude',
        inputTokens: 43,
        outputTokens: 385,
        model: 'claude-sonnet-4-6',
      },
    });
    expect(onStore).not.toHaveBeenCalled();
  });

  it('drops messages with wrong namespace (Layer 3)', () => {
    bridge({
      origin: 'https://claude.ai',
      data: {
        namespace: 'HIJACK_NS',
        token: sessionToken,
        type: 'TOKEN_BATCH',
        platform: 'claude',
        inputTokens: 43,
        outputTokens: 385,
        model: 'claude-sonnet-4-6',
      },
    });
    expect(onStore).not.toHaveBeenCalled();
  });

  it('drops messages with a wrong session token (Layer 4)', () => {
    bridge({
      origin: 'https://claude.ai',
      data: {
        namespace: LCO_NAMESPACE,
        token: crypto.randomUUID(), // different token
        type: 'TOKEN_BATCH',
        platform: 'claude',
        inputTokens: 43,
        outputTokens: 385,
        model: 'claude-sonnet-4-6',
      },
    });
    expect(onStore).not.toHaveBeenCalled();
  });

  it('drops messages with invalid schema (Layer 5)', () => {
    bridge({
      origin: 'https://claude.ai',
      data: {
        namespace: LCO_NAMESPACE,
        token: sessionToken,
        type: 'TOKEN_BATCH',
        // missing inputTokens, outputTokens, model
      },
    });
    expect(onStore).not.toHaveBeenCalled();
  });

  it('does not forward HEALTH_BROKEN to storage', () => {
    bridge({
      origin: 'https://claude.ai',
      data: {
        namespace: LCO_NAMESPACE,
        token: sessionToken,
        type: 'HEALTH_BROKEN',
        platform: 'claude',
        reason: 'missing_sentinel',
        message: 'stream_start event never arrived',
      },
    });
    // HEALTH_BROKEN updates UI state only, not storage
    expect(onStore).not.toHaveBeenCalled();
  });

  it('does not forward HEALTH_RECOVERED to storage', () => {
    bridge({
      origin: 'https://claude.ai',
      data: {
        namespace: LCO_NAMESPACE,
        token: sessionToken,
        type: 'HEALTH_RECOVERED',
        platform: 'claude',
        recoveredAt: Date.now(),
      },
    });
    // HEALTH_RECOVERED clears UI warning only, not storage
    expect(onStore).not.toHaveBeenCalled();
  });

  it('does not forward MESSAGE_LIMIT_UPDATE to storage', () => {
    bridge({
      origin: 'https://claude.ai',
      data: {
        namespace: LCO_NAMESPACE,
        token: sessionToken,
        type: 'MESSAGE_LIMIT_UPDATE',
        platform: 'claude',
        messageLimitUtilization: 0.48,
      },
    });
    // MESSAGE_LIMIT_UPDATE goes to a separate background handler, not STORE_TOKEN_BATCH
    expect(onStore).not.toHaveBeenCalled();
  });

  it('drops MESSAGE_LIMIT_UPDATE with non-numeric utilization', () => {
    bridge({
      origin: 'https://claude.ai',
      data: {
        namespace: LCO_NAMESPACE,
        token: sessionToken,
        type: 'MESSAGE_LIMIT_UPDATE',
        platform: 'claude',
        messageLimitUtilization: 'high', // wrong type
      },
    });
    expect(onStore).not.toHaveBeenCalled();
  });
});
