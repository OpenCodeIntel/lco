// tests/unit/message-security.test.ts
// Unit tests for the 5-layer bridge security model.
// Validates: schema structure, namespace isolation, token matching.

import { describe, it, expect } from 'vitest';
import { LCO_NAMESPACE } from '../../lib/message-types';

/**
 * Mirror of the isValidBridgeSchema() function from claude-ai.content.ts.
 * Extracted here so it can be unit tested independently of the browser runtime.
 */
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

describe('5-layer bridge schema validator', () => {
  const validToken = crypto.randomUUID();

  it('accepts a valid TOKEN_BATCH message', () => {
    expect(
      isValidBridgeSchema({
        namespace: LCO_NAMESPACE,
        token: validToken,
        type: 'TOKEN_BATCH',
        platform: 'claude',
        inputTokens: 10,
        outputTokens: 42,
        model: 'claude-sonnet-4-6',
      }),
    ).toBe(true);
  });

  it('accepts a valid STREAM_COMPLETE message', () => {
    expect(
      isValidBridgeSchema({
        namespace: LCO_NAMESPACE,
        token: validToken,
        type: 'STREAM_COMPLETE',
        platform: 'claude',
        inputTokens: 10,
        outputTokens: 42,
        model: 'claude-sonnet-4-6',
        stopReason: 'end_turn',
      }),
    ).toBe(true);
  });

  it('accepts a HEALTH_BROKEN message without numeric fields', () => {
    expect(
      isValidBridgeSchema({
        namespace: LCO_NAMESPACE,
        token: validToken,
        type: 'HEALTH_BROKEN',
        platform: 'claude',
        reason: 'missing_sentinel',
        message: 'SSE lifecycle events missing',
      }),
    ).toBe(true);
  });

  it('accepts a HEALTH_RECOVERED message', () => {
    expect(
      isValidBridgeSchema({
        namespace: LCO_NAMESPACE,
        token: validToken,
        type: 'HEALTH_RECOVERED',
        platform: 'claude',
        recoveredAt: Date.now(),
      }),
    ).toBe(true);
  });

  it('rejects HEALTH_RECOVERED with missing recoveredAt field', () => {
    expect(
      isValidBridgeSchema({
        namespace: LCO_NAMESPACE,
        token: validToken,
        type: 'HEALTH_RECOVERED',
        platform: 'claude',
      }),
    ).toBe(false);
  });

  it('rejects HEALTH_RECOVERED with non-numeric recoveredAt', () => {
    expect(
      isValidBridgeSchema({
        namespace: LCO_NAMESPACE,
        token: validToken,
        type: 'HEALTH_RECOVERED',
        platform: 'claude',
        recoveredAt: 'now',
      }),
    ).toBe(false);
  });

  it('accepts a valid MESSAGE_LIMIT_UPDATE message', () => {
    expect(
      isValidBridgeSchema({
        namespace: LCO_NAMESPACE,
        token: validToken,
        type: 'MESSAGE_LIMIT_UPDATE',
        platform: 'claude',
        messageLimitUtilization: 0.48,
      }),
    ).toBe(true);
  });

  it('rejects MESSAGE_LIMIT_UPDATE with missing utilization field', () => {
    expect(
      isValidBridgeSchema({
        namespace: LCO_NAMESPACE,
        token: validToken,
        type: 'MESSAGE_LIMIT_UPDATE',
        platform: 'claude',
      }),
    ).toBe(false);
  });

  it('rejects HEALTH_BROKEN with missing message field', () => {
    expect(
      isValidBridgeSchema({
        namespace: LCO_NAMESPACE,
        token: validToken,
        type: 'HEALTH_BROKEN',
        platform: 'claude',
      }),
    ).toBe(false);
  });

  it('rejects null', () => {
    expect(isValidBridgeSchema(null)).toBe(false);
  });

  it('rejects a non-object', () => {
    expect(isValidBridgeSchema('lco_string')).toBe(false);
  });

  it('rejects wrong namespace (Layer 3)', () => {
    expect(
      isValidBridgeSchema({
        namespace: 'WRONG_NS',
        token: validToken,
        type: 'TOKEN_BATCH',
        inputTokens: 10,
        outputTokens: 5,
        model: 'claude-sonnet-4-6',
      }),
    ).toBe(false);
  });

  it('rejects empty token (Layer 4)', () => {
    expect(
      isValidBridgeSchema({
        namespace: LCO_NAMESPACE,
        token: '',
        type: 'TOKEN_BATCH',
        inputTokens: 10,
        outputTokens: 5,
        model: 'claude-sonnet-4-6',
      }),
    ).toBe(false);
  });

  it('rejects missing token field (Layer 4)', () => {
    expect(
      isValidBridgeSchema({
        namespace: LCO_NAMESPACE,
        type: 'TOKEN_BATCH',
        inputTokens: 10,
        outputTokens: 5,
        model: 'claude-sonnet-4-6',
      }),
    ).toBe(false);
  });

  it('rejects unknown message type (Layer 5)', () => {
    expect(
      isValidBridgeSchema({
        namespace: LCO_NAMESPACE,
        token: validToken,
        type: 'MALICIOUS_TYPE',
        inputTokens: 10,
        outputTokens: 5,
        model: 'claude-sonnet-4-6',
      }),
    ).toBe(false);
  });

  it('rejects TOKEN_BATCH with missing numeric fields (Layer 5)', () => {
    expect(
      isValidBridgeSchema({
        namespace: LCO_NAMESPACE,
        token: validToken,
        type: 'TOKEN_BATCH',
        model: 'claude-sonnet-4-6',
        // inputTokens and outputTokens intentionally omitted
      }),
    ).toBe(false);
  });

  it('rejects TOKEN_BATCH with string instead of numeric token counts (Layer 5)', () => {
    expect(
      isValidBridgeSchema({
        namespace: LCO_NAMESPACE,
        token: validToken,
        type: 'TOKEN_BATCH',
        inputTokens: '10', // wrong type: string instead of number
        outputTokens: 5,
        model: 'claude-sonnet-4-6',
      }),
    ).toBe(false);
  });
});

describe('session token generation', () => {
  it('produces a valid UUID v4 format', () => {
    const token = crypto.randomUUID();
    expect(token).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('produces unique tokens on each call', () => {
    const tokens = new Set(Array.from({ length: 100 }, () => crypto.randomUUID()));
    expect(tokens.size).toBe(100);
  });
});
