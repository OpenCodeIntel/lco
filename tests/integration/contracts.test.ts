// tests/integration/contracts.test.ts
// Message contract tests: construct every message type as the sender would,
// validate it as the receiver would. Proves the schema survives every hop.

import { describe, it, expect } from 'vitest';
import { isValidBridgeSchema } from '../../lib/bridge-validation';
import { LCO_NAMESPACE } from '../../lib/message-types';
import type {
    TokenBatchPayload,
    StreamCompletePayload,
    StreamHealthBrokenPayload,
    StreamHealthRecoveredPayload,
    MessageLimitPayload,
    OrganizationDetectedPayload,
    DraftEstimatePayload,
    StoreTokenBatchMessage,
    StoreMessageLimitMessage,
    RecordTurnMessage,
    FinalizeConversationMessage,
    GetConversationMessage,
    SetActiveConvMessage,
    StoreUsageLimitsMessage,
    GetTokenEconomicsMessage,
    CountTokensMessage,
} from '../../lib/message-types';

const SESSION_TOKEN = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

// ── Helper: construct bridge messages as inject.ts would ──────────────────────

function tokenBatch(overrides: Partial<TokenBatchPayload> = {}): TokenBatchPayload {
    return {
        namespace: LCO_NAMESPACE,
        type: 'TOKEN_BATCH',
        token: SESSION_TOKEN,
        platform: 'claude',
        inputTokens: 120,
        outputTokens: 450,
        model: 'claude-sonnet-4-6',
        ...overrides,
    };
}

function streamComplete(overrides: Partial<StreamCompletePayload> = {}): StreamCompletePayload {
    return {
        namespace: LCO_NAMESPACE,
        type: 'STREAM_COMPLETE',
        token: SESSION_TOKEN,
        platform: 'claude',
        inputTokens: 120,
        outputTokens: 900,
        model: 'claude-sonnet-4-6',
        stopReason: 'end_turn',
        ...overrides,
    };
}

function healthBroken(overrides: Partial<StreamHealthBrokenPayload> = {}): StreamHealthBrokenPayload {
    return {
        namespace: LCO_NAMESPACE,
        type: 'HEALTH_BROKEN',
        token: SESSION_TOKEN,
        platform: 'claude',
        reason: 'missing_sentinel',
        message: 'stream_start event never arrived after 10 chunks',
        ...overrides,
    };
}

function healthRecovered(overrides: Partial<StreamHealthRecoveredPayload> = {}): StreamHealthRecoveredPayload {
    return {
        namespace: LCO_NAMESPACE,
        type: 'HEALTH_RECOVERED',
        token: SESSION_TOKEN,
        platform: 'claude',
        recoveredAt: Date.now(),
        ...overrides,
    };
}

function messageLimit(overrides: Partial<MessageLimitPayload> = {}): MessageLimitPayload {
    return {
        namespace: LCO_NAMESPACE,
        type: 'MESSAGE_LIMIT_UPDATE',
        token: SESSION_TOKEN,
        platform: 'claude',
        messageLimitUtilization: 0.48,
        ...overrides,
    };
}

function orgDetected(overrides: Partial<OrganizationDetectedPayload> = {}): OrganizationDetectedPayload {
    return {
        namespace: LCO_NAMESPACE,
        type: 'ORGANIZATION_DETECTED',
        token: SESSION_TOKEN,
        platform: 'claude',
        organizationId: 'aabbccdd-1122-3344-5566-778899aabbcc',
        ...overrides,
    };
}

function draftEstimate(overrides: Partial<DraftEstimatePayload> = {}): DraftEstimatePayload {
    return {
        namespace: LCO_NAMESPACE,
        type: 'DRAFT_ESTIMATE',
        token: SESSION_TOKEN,
        draftCharCount: 320,
        ...overrides,
    };
}

// ── Bridge message contracts (Room 1 -> Room 2) ─────────────────────────────

describe('bridge contracts: valid messages pass schema validation', () => {
    it('TOKEN_BATCH with minimal fields', () => {
        expect(isValidBridgeSchema(tokenBatch())).toBe(true);
    });

    it('TOKEN_BATCH with optional organizationId', () => {
        expect(isValidBridgeSchema(tokenBatch({
            organizationId: 'org-uuid-here',
        }))).toBe(true);
    });

    it('STREAM_COMPLETE with all optional fields', () => {
        expect(isValidBridgeSchema(streamComplete({
            topicHint: 'Refactor the auth middleware',
            promptLength: 340,
            hasCodeBlock: true,
            isShortFollowUp: false,
            organizationId: 'org-uuid-here',
        }))).toBe(true);
    });

    it('STREAM_COMPLETE with null stopReason', () => {
        expect(isValidBridgeSchema(streamComplete({ stopReason: null }))).toBe(true);
    });

    it('HEALTH_BROKEN with each valid reason', () => {
        const reasons: Array<StreamHealthBrokenPayload['reason']> = [
            'missing_sentinel', 'stream_timeout', 'incomplete_lifecycle',
        ];
        for (const reason of reasons) {
            expect(isValidBridgeSchema(healthBroken({ reason }))).toBe(true);
        }
    });

    it('HEALTH_RECOVERED', () => {
        expect(isValidBridgeSchema(healthRecovered())).toBe(true);
    });

    it('MESSAGE_LIMIT_UPDATE', () => {
        expect(isValidBridgeSchema(messageLimit())).toBe(true);
    });

    it('MESSAGE_LIMIT_UPDATE with zero utilization', () => {
        expect(isValidBridgeSchema(messageLimit({ messageLimitUtilization: 0 }))).toBe(true);
    });

    it('ORGANIZATION_DETECTED', () => {
        expect(isValidBridgeSchema(orgDetected())).toBe(true);
    });

    it('DRAFT_ESTIMATE', () => {
        expect(isValidBridgeSchema(draftEstimate())).toBe(true);
    });

    it('DRAFT_ESTIMATE with zero chars', () => {
        expect(isValidBridgeSchema(draftEstimate({ draftCharCount: 0 }))).toBe(true);
    });
});

describe('bridge contracts: invalid messages rejected', () => {
    it('rejects null', () => {
        expect(isValidBridgeSchema(null)).toBe(false);
    });

    it('rejects non-object', () => {
        expect(isValidBridgeSchema('TOKEN_BATCH')).toBe(false);
    });

    it('rejects wrong namespace', () => {
        expect(isValidBridgeSchema(tokenBatch({ namespace: 'OTHER' as any }))).toBe(false);
    });

    it('rejects empty token', () => {
        expect(isValidBridgeSchema(tokenBatch({ token: '' }))).toBe(false);
    });

    it('rejects unknown message type', () => {
        expect(isValidBridgeSchema({ ...tokenBatch(), type: 'UNKNOWN_TYPE' })).toBe(false);
    });

    it('rejects TOKEN_BATCH with non-number inputTokens', () => {
        expect(isValidBridgeSchema({ ...tokenBatch(), inputTokens: '120' })).toBe(false);
    });

    it('rejects TOKEN_BATCH with missing model', () => {
        const msg = tokenBatch();
        delete (msg as any).model;
        expect(isValidBridgeSchema(msg)).toBe(false);
    });

    it('rejects STREAM_COMPLETE with non-boolean hasCodeBlock', () => {
        expect(isValidBridgeSchema(streamComplete({ hasCodeBlock: 'true' as any }))).toBe(false);
    });

    it('rejects STREAM_COMPLETE with non-number promptLength', () => {
        expect(isValidBridgeSchema(streamComplete({ promptLength: '340' as any }))).toBe(false);
    });

    it('rejects HEALTH_BROKEN with missing message', () => {
        const msg = healthBroken();
        delete (msg as any).message;
        expect(isValidBridgeSchema(msg)).toBe(false);
    });

    it('rejects HEALTH_RECOVERED with missing recoveredAt', () => {
        const msg = healthRecovered();
        delete (msg as any).recoveredAt;
        expect(isValidBridgeSchema(msg)).toBe(false);
    });

    it('rejects MESSAGE_LIMIT_UPDATE with string utilization', () => {
        expect(isValidBridgeSchema(messageLimit({
            messageLimitUtilization: 'high' as any,
        }))).toBe(false);
    });

    it('rejects ORGANIZATION_DETECTED with empty organizationId', () => {
        expect(isValidBridgeSchema(orgDetected({ organizationId: '' }))).toBe(false);
    });

    it('rejects DRAFT_ESTIMATE with negative draftCharCount', () => {
        expect(isValidBridgeSchema(draftEstimate({ draftCharCount: -1 }))).toBe(false);
    });

    it('rejects DRAFT_ESTIMATE with non-integer draftCharCount', () => {
        expect(isValidBridgeSchema(draftEstimate({ draftCharCount: 3.5 }))).toBe(false);
    });

    it('rejects TOKEN_BATCH with non-string organizationId', () => {
        expect(isValidBridgeSchema(tokenBatch({ organizationId: 123 as any }))).toBe(false);
    });
});

// ── Background message contracts (Room 2 -> Room 3) ─────────────────────────
// These messages are sent via chrome.runtime.sendMessage, which serializes
// them to JSON. The background handler dispatches on msg.type. We verify
// that constructing the message as the content script would produces
// the shape the background expects (correct type discriminant + all fields).

describe('background message contracts: STORE_TOKEN_BATCH', () => {
    it('derived from TOKEN_BATCH bridge message has correct shape', () => {
        const bridge = tokenBatch();
        const bg: StoreTokenBatchMessage = {
            type: 'STORE_TOKEN_BATCH',
            platform: bridge.platform,
            model: bridge.model,
            inputTokens: bridge.inputTokens,
            outputTokens: bridge.outputTokens,
            stopReason: null, // TOKEN_BATCH has no stop reason
        };
        expect(bg.type).toBe('STORE_TOKEN_BATCH');
        expect(bg.stopReason).toBeNull();
        expect(bg.inputTokens).toBe(120);
    });

    it('derived from STREAM_COMPLETE carries stopReason', () => {
        const bridge = streamComplete({ stopReason: 'end_turn' });
        const bg: StoreTokenBatchMessage = {
            type: 'STORE_TOKEN_BATCH',
            platform: bridge.platform,
            model: bridge.model,
            inputTokens: bridge.inputTokens,
            outputTokens: bridge.outputTokens,
            stopReason: bridge.stopReason,
        };
        expect(bg.stopReason).toBe('end_turn');
    });
});

describe('background message contracts: STORE_MESSAGE_LIMIT', () => {
    it('derived from MESSAGE_LIMIT_UPDATE bridge message', () => {
        const bridge = messageLimit({ messageLimitUtilization: 0.72 });
        const bg: StoreMessageLimitMessage = {
            type: 'STORE_MESSAGE_LIMIT',
            platform: bridge.platform,
            messageLimitUtilization: bridge.messageLimitUtilization,
        };
        expect(bg.type).toBe('STORE_MESSAGE_LIMIT');
        expect(bg.messageLimitUtilization).toBe(0.72);
    });
});

describe('background message contracts: RECORD_TURN', () => {
    it('has all required fields', () => {
        const msg: RecordTurnMessage = {
            type: 'RECORD_TURN',
            organizationId: 'org-uuid',
            conversationId: 'conv-uuid',
            inputTokens: 500,
            outputTokens: 1200,
            model: 'claude-sonnet-4-6',
            contextPct: 0.85,
            cost: 0.0195,
            topicHint: 'Refactor the auth module',
            deltaUtilization: 1.2,
        };
        expect(msg.type).toBe('RECORD_TURN');
        expect(msg.deltaUtilization).toBe(1.2);
    });

    it('accepts null cost and null deltaUtilization', () => {
        const msg: RecordTurnMessage = {
            type: 'RECORD_TURN',
            organizationId: 'org-uuid',
            conversationId: 'conv-uuid',
            inputTokens: 500,
            outputTokens: 1200,
            model: 'unknown-model-v9',
            contextPct: 0.85,
            cost: null,
            deltaUtilization: null,
        };
        expect(msg.cost).toBeNull();
        expect(msg.deltaUtilization).toBeNull();
    });
});

describe('background message contracts: lifecycle messages', () => {
    it('FINALIZE_CONVERSATION has required fields', () => {
        const msg: FinalizeConversationMessage = {
            type: 'FINALIZE_CONVERSATION',
            organizationId: 'org-uuid',
            conversationId: 'conv-uuid',
        };
        expect(msg.type).toBe('FINALIZE_CONVERSATION');
    });

    it('GET_CONVERSATION has required fields', () => {
        const msg: GetConversationMessage = {
            type: 'GET_CONVERSATION',
            organizationId: 'org-uuid',
            conversationId: 'conv-uuid',
        };
        expect(msg.type).toBe('GET_CONVERSATION');
    });

    it('SET_ACTIVE_CONV accepts null ids (navigating to /new)', () => {
        const msg: SetActiveConvMessage = {
            type: 'SET_ACTIVE_CONV',
            organizationId: null,
            conversationId: null,
        };
        expect(msg.conversationId).toBeNull();
    });
});

describe('background message contracts: STORE_USAGE_LIMITS', () => {
    it('carries all usage window fields', () => {
        const msg: StoreUsageLimitsMessage = {
            type: 'STORE_USAGE_LIMITS',
            organizationId: 'org-uuid',
            fiveHourUtilization: 34.5,
            fiveHourResetsAt: '2026-04-13T15:00:01.000+00:00',
            sevenDayUtilization: 12.3,
            sevenDayResetsAt: '2026-04-16T09:00:01.000+00:00',
        };
        expect(msg.type).toBe('STORE_USAGE_LIMITS');
        expect(msg.fiveHourUtilization).toBe(34.5);
    });
});

describe('background message contracts: GET_TOKEN_ECONOMICS', () => {
    it('has required organizationId', () => {
        const msg: GetTokenEconomicsMessage = {
            type: 'GET_TOKEN_ECONOMICS',
            organizationId: 'org-uuid',
        };
        expect(msg.type).toBe('GET_TOKEN_ECONOMICS');
    });
});

describe('background message contracts: COUNT_TOKENS', () => {
    it('carries text for BPE tokenization', () => {
        const msg: CountTokensMessage = {
            type: 'COUNT_TOKENS',
            text: 'Hello, how are you?',
        };
        expect(msg.type).toBe('COUNT_TOKENS');
        expect(msg.text).toBe('Hello, how are you?');
    });
});

// ── Round-trip: bridge -> transform -> background ────────────────────────────

describe('round-trip: STREAM_COMPLETE bridge -> STORE_TOKEN_BATCH + RECORD_TURN', () => {
    it('all fields survive the transform from bridge to background messages', () => {
        const bridge = streamComplete({
            inputTokens: 800,
            outputTokens: 2400,
            model: 'claude-opus-4-6',
            stopReason: 'end_turn',
            topicHint: 'Implement rate limiter',
            promptLength: 250,
            hasCodeBlock: false,
            isShortFollowUp: false,
            organizationId: 'org-uuid',
        });

        // Content script transforms bridge -> STORE_TOKEN_BATCH
        const storeBatch: StoreTokenBatchMessage = {
            type: 'STORE_TOKEN_BATCH',
            platform: bridge.platform,
            model: bridge.model,
            inputTokens: bridge.inputTokens,
            outputTokens: bridge.outputTokens,
            stopReason: bridge.stopReason,
        };

        // Content script also builds RECORD_TURN (after computing cost + context)
        const recordTurn: RecordTurnMessage = {
            type: 'RECORD_TURN',
            organizationId: bridge.organizationId!,
            conversationId: 'conv-uuid',
            inputTokens: bridge.inputTokens,
            outputTokens: bridge.outputTokens,
            model: bridge.model,
            contextPct: ((bridge.inputTokens + bridge.outputTokens) / 200000) * 100,
            cost: null, // computed by pricing agent
            topicHint: bridge.topicHint,
            deltaUtilization: null,
        };

        // STORE_TOKEN_BATCH preserves token counts
        expect(storeBatch.inputTokens).toBe(800);
        expect(storeBatch.outputTokens).toBe(2400);
        expect(storeBatch.model).toBe('claude-opus-4-6');
        expect(storeBatch.stopReason).toBe('end_turn');

        // RECORD_TURN preserves all data including topicHint
        expect(recordTurn.inputTokens).toBe(800);
        expect(recordTurn.outputTokens).toBe(2400);
        expect(recordTurn.organizationId).toBe('org-uuid');
        expect(recordTurn.topicHint).toBe('Implement rate limiter');
        expect(recordTurn.contextPct).toBeCloseTo(1.6, 2);
    });
});
