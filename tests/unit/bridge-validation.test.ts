// tests/unit/bridge-validation.test.ts
// Tests the actual isValidBridgeSchema import, not a mirror copy.

import { describe, it, expect } from 'vitest';
import { isValidBridgeSchema } from '../../lib/bridge-validation';
import { LCO_NAMESPACE } from '../../lib/message-types';

function base(overrides = {}) {
    return {
        namespace: LCO_NAMESPACE,
        token: 'test-token-uuid',
        type: 'TOKEN_BATCH',
        inputTokens: 100,
        outputTokens: 20,
        model: 'claude-haiku-4-5',
        platform: 'claude.ai',
        ...overrides,
    };
}

// ── Top-level guards ──────────────────────────────────────────────────────────

describe('top-level guards', () => {
    it('rejects null', () => {
        expect(isValidBridgeSchema(null)).toBe(false);
    });

    it('rejects a string', () => {
        expect(isValidBridgeSchema('hello')).toBe(false);
    });

    it('rejects a number', () => {
        expect(isValidBridgeSchema(42)).toBe(false);
    });

    it('rejects an array', () => {
        expect(isValidBridgeSchema([])).toBe(false);
    });

    it('rejects wrong namespace', () => {
        expect(isValidBridgeSchema(base({ namespace: 'WRONG' }))).toBe(false);
    });

    it('rejects missing namespace', () => {
        const { namespace: _, ...rest } = base();
        expect(isValidBridgeSchema(rest)).toBe(false);
    });

    it('rejects empty token string', () => {
        expect(isValidBridgeSchema(base({ token: '' }))).toBe(false);
    });

    it('rejects non-string token', () => {
        expect(isValidBridgeSchema(base({ token: 123 }))).toBe(false);
    });

    it('rejects unknown message type', () => {
        expect(isValidBridgeSchema(base({ type: 'UNKNOWN_TYPE' }))).toBe(false);
    });

    it('rejects missing type', () => {
        const { type: _, ...rest } = base();
        expect(isValidBridgeSchema(rest)).toBe(false);
    });
});

// ── TOKEN_BATCH ───────────────────────────────────────────────────────────────

describe('TOKEN_BATCH', () => {
    it('accepts a valid TOKEN_BATCH message', () => {
        expect(isValidBridgeSchema(base({ type: 'TOKEN_BATCH' }))).toBe(true);
    });

    it('rejects missing inputTokens', () => {
        const { inputTokens: _, ...rest } = base({ type: 'TOKEN_BATCH' });
        expect(isValidBridgeSchema(rest)).toBe(false);
    });

    it('rejects non-number inputTokens', () => {
        expect(isValidBridgeSchema(base({ type: 'TOKEN_BATCH', inputTokens: '100' }))).toBe(false);
    });

    it('rejects missing outputTokens', () => {
        const { outputTokens: _, ...rest } = base({ type: 'TOKEN_BATCH' });
        expect(isValidBridgeSchema(rest)).toBe(false);
    });

    it('rejects missing model', () => {
        const { model: _, ...rest } = base({ type: 'TOKEN_BATCH' });
        expect(isValidBridgeSchema(rest)).toBe(false);
    });

    it('rejects non-string model', () => {
        expect(isValidBridgeSchema(base({ type: 'TOKEN_BATCH', model: 99 }))).toBe(false);
    });
});

// ── STREAM_COMPLETE ───────────────────────────────────────────────────────────

describe('STREAM_COMPLETE', () => {
    it('accepts a valid STREAM_COMPLETE message', () => {
        expect(isValidBridgeSchema(base({ type: 'STREAM_COMPLETE' }))).toBe(true);
    });

    it('rejects missing inputTokens', () => {
        const { inputTokens: _, ...rest } = base({ type: 'STREAM_COMPLETE' });
        expect(isValidBridgeSchema(rest)).toBe(false);
    });

    it('rejects missing model', () => {
        const { model: _, ...rest } = base({ type: 'STREAM_COMPLETE' });
        expect(isValidBridgeSchema(rest)).toBe(false);
    });
});

// ── organizationId (shared by TOKEN_BATCH and STREAM_COMPLETE) ───────────────

describe('organizationId field', () => {
    it('accepts TOKEN_BATCH with valid organizationId', () => {
        expect(isValidBridgeSchema(base({
            type: 'TOKEN_BATCH',
            organizationId: 'org-abc-123',
        }))).toBe(true);
    });

    it('accepts TOKEN_BATCH without organizationId (backward compat)', () => {
        expect(isValidBridgeSchema(base({ type: 'TOKEN_BATCH' }))).toBe(true);
    });

    it('rejects TOKEN_BATCH with non-string organizationId', () => {
        expect(isValidBridgeSchema(base({
            type: 'TOKEN_BATCH',
            organizationId: 42,
        }))).toBe(false);
    });

    it('accepts STREAM_COMPLETE with valid organizationId', () => {
        expect(isValidBridgeSchema(base({
            type: 'STREAM_COMPLETE',
            organizationId: 'org-xyz-789',
        }))).toBe(true);
    });

    it('rejects STREAM_COMPLETE with non-string organizationId', () => {
        expect(isValidBridgeSchema(base({
            type: 'STREAM_COMPLETE',
            organizationId: true,
        }))).toBe(false);
    });
});

// ── HEALTH_BROKEN ─────────────────────────────────────────────────────────────

describe('HEALTH_BROKEN', () => {
    it('accepts a valid HEALTH_BROKEN message', () => {
        expect(isValidBridgeSchema({
            namespace: LCO_NAMESPACE,
            token: 'tok',
            type: 'HEALTH_BROKEN',
            message: 'fetch failed',
        })).toBe(true);
    });

    it('rejects missing message field', () => {
        expect(isValidBridgeSchema({
            namespace: LCO_NAMESPACE,
            token: 'tok',
            type: 'HEALTH_BROKEN',
        })).toBe(false);
    });

    it('rejects non-string message field', () => {
        expect(isValidBridgeSchema({
            namespace: LCO_NAMESPACE,
            token: 'tok',
            type: 'HEALTH_BROKEN',
            message: 404,
        })).toBe(false);
    });
});

// ── HEALTH_RECOVERED ──────────────────────────────────────────────────────────

describe('HEALTH_RECOVERED', () => {
    it('accepts a valid HEALTH_RECOVERED message', () => {
        expect(isValidBridgeSchema({
            namespace: LCO_NAMESPACE,
            token: 'tok',
            type: 'HEALTH_RECOVERED',
            recoveredAt: Date.now(),
        })).toBe(true);
    });

    it('rejects missing recoveredAt', () => {
        expect(isValidBridgeSchema({
            namespace: LCO_NAMESPACE,
            token: 'tok',
            type: 'HEALTH_RECOVERED',
        })).toBe(false);
    });

    it('rejects non-number recoveredAt', () => {
        expect(isValidBridgeSchema({
            namespace: LCO_NAMESPACE,
            token: 'tok',
            type: 'HEALTH_RECOVERED',
            recoveredAt: '2026-01-01',
        })).toBe(false);
    });
});

// ── STREAM_COMPLETE: new optional fields ──────────────────────────────────────

describe('STREAM_COMPLETE: optional prompt characteristic fields', () => {
    it('accepts STREAM_COMPLETE with all three new fields present', () => {
        expect(isValidBridgeSchema(base({
            type: 'STREAM_COMPLETE',
            promptLength: 120,
            hasCodeBlock: false,
            isShortFollowUp: true,
        }))).toBe(true);
    });

    it('accepts STREAM_COMPLETE without any new fields (backward compat)', () => {
        expect(isValidBridgeSchema(base({ type: 'STREAM_COMPLETE' }))).toBe(true);
    });

    it('rejects STREAM_COMPLETE with non-number promptLength', () => {
        expect(isValidBridgeSchema(base({
            type: 'STREAM_COMPLETE',
            promptLength: '120',
        }))).toBe(false);
    });

    it('rejects STREAM_COMPLETE with non-boolean hasCodeBlock', () => {
        expect(isValidBridgeSchema(base({
            type: 'STREAM_COMPLETE',
            hasCodeBlock: 'true',
        }))).toBe(false);
    });

    it('rejects STREAM_COMPLETE with non-boolean isShortFollowUp', () => {
        expect(isValidBridgeSchema(base({
            type: 'STREAM_COMPLETE',
            isShortFollowUp: 0,
        }))).toBe(false);
    });
});

// ── MESSAGE_LIMIT_UPDATE ──────────────────────────────────────────────────────

describe('MESSAGE_LIMIT_UPDATE', () => {
    it('accepts a valid MESSAGE_LIMIT_UPDATE message', () => {
        expect(isValidBridgeSchema({
            namespace: LCO_NAMESPACE,
            token: 'tok',
            type: 'MESSAGE_LIMIT_UPDATE',
            messageLimitUtilization: 0.72,
            platform: 'claude.ai',
        })).toBe(true);
    });

    it('rejects missing messageLimitUtilization', () => {
        expect(isValidBridgeSchema({
            namespace: LCO_NAMESPACE,
            token: 'tok',
            type: 'MESSAGE_LIMIT_UPDATE',
        })).toBe(false);
    });

    it('rejects non-number messageLimitUtilization', () => {
        expect(isValidBridgeSchema({
            namespace: LCO_NAMESPACE,
            token: 'tok',
            type: 'MESSAGE_LIMIT_UPDATE',
            messageLimitUtilization: '0.72',
        })).toBe(false);
    });
});
