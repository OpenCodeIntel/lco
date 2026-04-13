import { describe, test, expect } from 'vitest';

// Audit: lib/bridge-validation.ts - security validation, prior audit HIGH-001 verification

import { isValidBridgeSchema } from '../../lib/bridge-validation';
import { LCO_NAMESPACE } from '../../lib/message-types';

function validTokenBatch() {
    return {
        namespace: LCO_NAMESPACE,
        token: 'abc-123-uuid',
        type: 'TOKEN_BATCH',
        inputTokens: 100,
        outputTokens: 50,
        model: 'claude-sonnet-4-6',
    };
}

function validStreamComplete() {
    return {
        namespace: LCO_NAMESPACE,
        token: 'abc-123-uuid',
        type: 'STREAM_COMPLETE',
        inputTokens: 100,
        outputTokens: 50,
        model: 'claude-sonnet-4-6',
    };
}

// ── Valid messages ──────────────────────────────────────────────────────────

describe('valid messages', () => {
    test('TOKEN_BATCH with required fields', () => {
        expect(isValidBridgeSchema(validTokenBatch())).toBe(true);
    });

    test('STREAM_COMPLETE with required fields', () => {
        expect(isValidBridgeSchema(validStreamComplete())).toBe(true);
    });

    test('STREAM_COMPLETE with optional prompt fields', () => {
        expect(isValidBridgeSchema({
            ...validStreamComplete(),
            promptLength: 200,
            hasCodeBlock: true,
            isShortFollowUp: false,
        })).toBe(true);
    });

    test('HEALTH_BROKEN', () => {
        expect(isValidBridgeSchema({
            namespace: LCO_NAMESPACE,
            token: 'x',
            type: 'HEALTH_BROKEN',
            message: 'sentinel missing',
        })).toBe(true);
    });

    test('HEALTH_RECOVERED', () => {
        expect(isValidBridgeSchema({
            namespace: LCO_NAMESPACE,
            token: 'x',
            type: 'HEALTH_RECOVERED',
            recoveredAt: Date.now(),
        })).toBe(true);
    });

    test('MESSAGE_LIMIT_UPDATE', () => {
        expect(isValidBridgeSchema({
            namespace: LCO_NAMESPACE,
            token: 'x',
            type: 'MESSAGE_LIMIT_UPDATE',
            messageLimitUtilization: 0.45,
        })).toBe(true);
    });

    test('ORGANIZATION_DETECTED', () => {
        expect(isValidBridgeSchema({
            namespace: LCO_NAMESPACE,
            token: 'x',
            type: 'ORGANIZATION_DETECTED',
            organizationId: 'org-uuid-123',
        })).toBe(true);
    });

    test('DRAFT_ESTIMATE', () => {
        expect(isValidBridgeSchema({
            namespace: LCO_NAMESPACE,
            token: 'x',
            type: 'DRAFT_ESTIMATE',
            draftCharCount: 200,
        })).toBe(true);
    });
});

// ── Missing required fields ────────────────────────────────────────────────

describe('missing required fields', () => {
    test('rejects null', () => {
        expect(isValidBridgeSchema(null)).toBe(false);
    });

    test('rejects undefined', () => {
        expect(isValidBridgeSchema(undefined)).toBe(false);
    });

    test('rejects non-object', () => {
        expect(isValidBridgeSchema('string')).toBe(false);
        expect(isValidBridgeSchema(42)).toBe(false);
        expect(isValidBridgeSchema(true)).toBe(false);
    });

    test('rejects empty object', () => {
        expect(isValidBridgeSchema({})).toBe(false);
    });

    test('rejects missing namespace', () => {
        const msg = validTokenBatch();
        delete (msg as any).namespace;
        expect(isValidBridgeSchema(msg)).toBe(false);
    });

    test('rejects wrong namespace', () => {
        expect(isValidBridgeSchema({ ...validTokenBatch(), namespace: 'WRONG' })).toBe(false);
    });

    test('rejects missing token', () => {
        const msg = validTokenBatch();
        delete (msg as any).token;
        expect(isValidBridgeSchema(msg)).toBe(false);
    });

    test('rejects empty token string', () => {
        expect(isValidBridgeSchema({ ...validTokenBatch(), token: '' })).toBe(false);
    });

    test('rejects unknown type', () => {
        expect(isValidBridgeSchema({ ...validTokenBatch(), type: 'UNKNOWN' })).toBe(false);
    });
});

// ── HIGH-001: BPE token bridge bypass ──────────────────────────────────────
// The prior audit claimed LCO_TOKEN_REQ/LCO_TOKEN_RES bypass the 5-layer security.
// Test whether bridge validation accepts these types.

describe('HIGH-001: BPE token bridge types', () => {
    test('LCO_TOKEN_REQ is NOT a valid bridge message type', () => {
        expect(isValidBridgeSchema({
            namespace: LCO_NAMESPACE,
            token: 'valid-token',
            type: 'LCO_TOKEN_REQ',
            payload: { text: 'test' },
        })).toBe(false);
    });

    test('LCO_TOKEN_RES is NOT a valid bridge message type', () => {
        expect(isValidBridgeSchema({
            namespace: LCO_NAMESPACE,
            token: 'valid-token',
            type: 'LCO_TOKEN_RES',
            payload: { count: 42 },
        })).toBe(false);
    });

    test('COUNT_TOKENS is NOT a valid bridge message type', () => {
        expect(isValidBridgeSchema({
            namespace: LCO_NAMESPACE,
            token: 'valid-token',
            type: 'COUNT_TOKENS',
            text: 'a'.repeat(10000),
        })).toBe(false);
    });
});

// ── Type-specific field validation ─────────────────────────────────────────

describe('type-specific validation', () => {
    test('TOKEN_BATCH rejects missing inputTokens', () => {
        const msg = { ...validTokenBatch() };
        delete (msg as any).inputTokens;
        expect(isValidBridgeSchema(msg)).toBe(false);
    });

    test('TOKEN_BATCH rejects string inputTokens', () => {
        expect(isValidBridgeSchema({ ...validTokenBatch(), inputTokens: '100' })).toBe(false);
    });

    test('TOKEN_BATCH rejects missing model', () => {
        const msg = { ...validTokenBatch() };
        delete (msg as any).model;
        expect(isValidBridgeSchema(msg)).toBe(false);
    });

    test('STREAM_COMPLETE rejects wrong type for promptLength', () => {
        expect(isValidBridgeSchema({
            ...validStreamComplete(),
            promptLength: 'long',
        })).toBe(false);
    });

    test('STREAM_COMPLETE rejects wrong type for hasCodeBlock', () => {
        expect(isValidBridgeSchema({
            ...validStreamComplete(),
            hasCodeBlock: 'yes',
        })).toBe(false);
    });

    test('HEALTH_BROKEN rejects missing message', () => {
        expect(isValidBridgeSchema({
            namespace: LCO_NAMESPACE,
            token: 'x',
            type: 'HEALTH_BROKEN',
        })).toBe(false);
    });

    test('HEALTH_RECOVERED rejects missing recoveredAt', () => {
        expect(isValidBridgeSchema({
            namespace: LCO_NAMESPACE,
            token: 'x',
            type: 'HEALTH_RECOVERED',
        })).toBe(false);
    });

    test('MESSAGE_LIMIT_UPDATE rejects string utilization', () => {
        expect(isValidBridgeSchema({
            namespace: LCO_NAMESPACE,
            token: 'x',
            type: 'MESSAGE_LIMIT_UPDATE',
            messageLimitUtilization: '0.45',
        })).toBe(false);
    });

    test('ORGANIZATION_DETECTED rejects empty organizationId', () => {
        expect(isValidBridgeSchema({
            namespace: LCO_NAMESPACE,
            token: 'x',
            type: 'ORGANIZATION_DETECTED',
            organizationId: '',
        })).toBe(false);
    });

    test('DRAFT_ESTIMATE rejects negative draftCharCount', () => {
        expect(isValidBridgeSchema({
            namespace: LCO_NAMESPACE,
            token: 'x',
            type: 'DRAFT_ESTIMATE',
            draftCharCount: -1,
        })).toBe(false);
    });

    test('DRAFT_ESTIMATE rejects non-integer draftCharCount', () => {
        expect(isValidBridgeSchema({
            namespace: LCO_NAMESPACE,
            token: 'x',
            type: 'DRAFT_ESTIMATE',
            draftCharCount: 3.5,
        })).toBe(false);
    });

    test('DRAFT_ESTIMATE rejects NaN draftCharCount', () => {
        expect(isValidBridgeSchema({
            namespace: LCO_NAMESPACE,
            token: 'x',
            type: 'DRAFT_ESTIMATE',
            draftCharCount: NaN,
        })).toBe(false);
    });

    test('DRAFT_ESTIMATE rejects Infinity draftCharCount', () => {
        expect(isValidBridgeSchema({
            namespace: LCO_NAMESPACE,
            token: 'x',
            type: 'DRAFT_ESTIMATE',
            draftCharCount: Infinity,
        })).toBe(false);
    });
});

// ── Prototype pollution ────────────────────────────────────────────────────

describe('prototype pollution defense', () => {
    test('__proto__ injection does not pollute Object.prototype', () => {
        const malicious = JSON.parse('{"__proto__":{"isAdmin":true},"namespace":"LCO_V1","token":"x","type":"TOKEN_BATCH","inputTokens":1,"outputTokens":1,"model":"x"}');
        isValidBridgeSchema(malicious);
        expect(({} as any).isAdmin).toBeUndefined();
    });

    test('constructor.prototype injection does not pollute', () => {
        const malicious = JSON.parse('{"constructor":{"prototype":{"isAdmin":true}},"namespace":"LCO_V1","token":"x","type":"TOKEN_BATCH","inputTokens":1,"outputTokens":1,"model":"x"}');
        isValidBridgeSchema(malicious);
        expect(({} as any).isAdmin).toBeUndefined();
    });
});
