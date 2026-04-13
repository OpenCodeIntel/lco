import { describe, test, expect } from 'vitest';

// Audit: lib/handoff-summary.ts - continuation prompt generation

import { buildHandoffSummary, deduplicateHints, type HandoffContext } from '../../lib/handoff-summary';
import type { ConversationRecord } from '../../lib/conversation-store';
import type { HealthScore } from '../../lib/health-score';

function makeRecord(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
    return {
        id: 'conv-1',
        startedAt: Date.now() - 60000,
        lastActiveAt: Date.now(),
        finalized: false,
        turnCount: 10,
        totalInputTokens: 50000,
        totalOutputTokens: 20000,
        peakContextPct: 60,
        lastContextPct: 60,
        model: 'claude-sonnet-4-6',
        estimatedCost: 0.5,
        turns: [],
        dna: {
            subject: 'Debug the authentication flow',
            lastContext: 'Fix the JWT refresh token expiry',
            hints: ['Fix the JWT refresh token expiry', 'Debug the authentication flow'],
        },
        _v: 1,
        ...overrides,
    };
}

function makeHealth(level: 'healthy' | 'degrading' | 'critical'): HealthScore {
    return {
        level,
        label: level.charAt(0).toUpperCase() + level.slice(1),
        coaching: 'test coaching',
        contextPct: level === 'critical' ? 90 : level === 'degrading' ? 60 : 20,
    };
}

// ── buildHandoffSummary ────────────────────────────────────────────────────

describe('buildHandoffSummary', () => {
    test('contains continuation header', () => {
        const result = buildHandoffSummary({ conversation: makeRecord(), health: makeHealth('healthy') });
        expect(result).toContain('[Continuing from a previous conversation]');
    });

    test('contains session metadata', () => {
        const result = buildHandoffSummary({ conversation: makeRecord(), health: makeHealth('healthy') });
        expect(result).toContain('10 turns');
        expect(result).toContain('Sonnet 4.6');
    });

    test('critical health explains context window was full', () => {
        const result = buildHandoffSummary({ conversation: makeRecord(), health: makeHealth('critical') });
        expect(result).toContain('context window was nearly full');
    });

    test('degrading health explains conversation was getting long', () => {
        const result = buildHandoffSummary({ conversation: makeRecord(), health: makeHealth('degrading') });
        expect(result).toContain('conversation was getting long');
    });

    test('healthy explains keeping things focused', () => {
        const result = buildHandoffSummary({ conversation: makeRecord(), health: makeHealth('healthy') });
        expect(result).toContain('keep things focused');
    });

    test('includes DNA subject and lastContext', () => {
        const result = buildHandoffSummary({ conversation: makeRecord(), health: makeHealth('healthy') });
        expect(result).toContain('Started with: Debug the authentication flow');
        expect(result).toContain('Last working on: Fix the JWT refresh token expiry');
    });

    test('skips lastContext when same as subject', () => {
        const record = makeRecord({
            dna: { subject: 'same topic', lastContext: 'same topic', hints: ['same topic'] },
        });
        const result = buildHandoffSummary({ conversation: record, health: makeHealth('healthy') });
        expect(result).toContain('Started with: same topic');
        // Should not have "Last working on: same topic" (duplicate)
        expect(result).not.toContain('Last working on:');
    });

    test('works without DNA (legacy records)', () => {
        const record = makeRecord({
            dna: { subject: '', lastContext: '', hints: [] },
        });
        const result = buildHandoffSummary({ conversation: record, health: makeHealth('healthy') });
        // Should still have header and metadata, but no DNA section
        expect(result).toContain('[Continuing from a previous conversation]');
        expect(result).not.toContain('Started with:');
    });

    test('ends with prompt for next steps', () => {
        const result = buildHandoffSummary({ conversation: makeRecord(), health: makeHealth('healthy') });
        expect(result).toContain('what I need to work on next');
    });

    test('single turn uses singular "turn"', () => {
        const record = makeRecord({ turnCount: 1 });
        const result = buildHandoffSummary({ conversation: record, health: makeHealth('healthy') });
        expect(result).toContain('1 turn,');
    });
});

// ── deduplicateHints ───────────────────────────────────────────────────────

describe('deduplicateHints', () => {
    test('returns empty for empty input', () => {
        expect(deduplicateHints([])).toEqual([]);
    });

    test('keeps unique hints', () => {
        const hints = ['Debug authentication', 'Fix database connection', 'Update API routes'];
        expect(deduplicateHints(hints)).toHaveLength(3);
    });

    test('removes duplicates by first 30 chars', () => {
        const hints = [
            'Debug the token refresh endpoint returning 401',
            'Debug the token refresh endpoint with cookies',
        ];
        expect(deduplicateHints(hints)).toHaveLength(1);
    });

    test('preserves order (first occurrence wins)', () => {
        const hints = ['First unique hint that is long', 'First unique hint that is different'];
        const result = deduplicateHints(hints);
        expect(result[0]).toBe('First unique hint that is long');
    });

    test('case-insensitive dedup', () => {
        const hints = ['Debug the Authentication Flow', 'debug the authentication flow'];
        expect(deduplicateHints(hints)).toHaveLength(1);
    });
});
