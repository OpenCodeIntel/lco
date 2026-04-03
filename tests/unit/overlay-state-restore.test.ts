// tests/unit/overlay-state-restore.test.ts
// Tests for restoring overlay state from a stored ConversationRecord.

import { describe, it, expect } from 'vitest';
import { INITIAL_STATE, applyRestoredConversation } from '../../lib/overlay-state';
import type { ConversationRecord } from '../../lib/conversation-store';
import { EMPTY_DNA } from '../../lib/conversation-store';
import type { HealthScore } from '../../lib/health-score';

function makeRecord(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
    return {
        id: 'test-conv-id',
        startedAt: Date.now() - 3600_000,
        lastActiveAt: Date.now(),
        finalized: false,
        turnCount: 8,
        totalInputTokens: 12000,
        totalOutputTokens: 8000,
        peakContextPct: 42,
        lastContextPct: 38,
        model: 'claude-sonnet-4-6',
        estimatedCost: 0.076,
        turns: [],
        dna: { ...EMPTY_DNA },
        _v: 1,
        ...overrides,
    };
}

const healthyScore: HealthScore = {
    level: 'healthy',
    label: 'Healthy',
    coaching: '38% context used. Plenty of room.',
    contextPct: 38,
};

describe('applyRestoredConversation', () => {
    it('restores context percentage from record', () => {
        const result = applyRestoredConversation(INITIAL_STATE, makeRecord(), healthyScore);
        expect(result.contextPct).toBe(38);
    });

    it('restores session totals from record', () => {
        const result = applyRestoredConversation(INITIAL_STATE, makeRecord(), healthyScore);
        expect(result.session.requestCount).toBe(8);
        expect(result.session.totalInputTokens).toBe(12000);
        expect(result.session.totalOutputTokens).toBe(8000);
        expect(result.session.totalCost).toBe(0.076);
    });

    it('restores health score', () => {
        const result = applyRestoredConversation(INITIAL_STATE, makeRecord(), healthyScore);
        expect(result.health).toBe(healthyScore);
    });

    it('preserves existing lastRequest (does not overwrite live data)', () => {
        const stateWithRequest = {
            ...INITIAL_STATE,
            lastRequest: {
                inputTokens: 500,
                outputTokens: 200,
                model: 'claude-sonnet-4-6',
                cost: 0.004,
            },
        };
        const result = applyRestoredConversation(stateWithRequest, makeRecord(), healthyScore);
        expect(result.lastRequest).toEqual(stateWithRequest.lastRequest);
    });

    it('preserves streaming flag', () => {
        const streaming = { ...INITIAL_STATE, streaming: true };
        const result = applyRestoredConversation(streaming, makeRecord(), healthyScore);
        expect(result.streaming).toBe(true);
    });

    it('handles null health score', () => {
        const result = applyRestoredConversation(INITIAL_STATE, makeRecord(), null);
        expect(result.health).toBeNull();
    });

    it('handles zero-cost record', () => {
        const record = makeRecord({ estimatedCost: 0, turnCount: 1, lastContextPct: 0.5 });
        const result = applyRestoredConversation(INITIAL_STATE, record, null);
        expect(result.session.totalCost).toBe(0);
        expect(result.contextPct).toBe(0.5);
    });

    it('handles null estimated cost', () => {
        const record = makeRecord({ estimatedCost: null as unknown as number });
        const result = applyRestoredConversation(INITIAL_STATE, record, healthyScore);
        expect(result.session.totalCost).toBeNull();
    });
});
