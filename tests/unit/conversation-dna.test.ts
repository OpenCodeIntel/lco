// tests/unit/conversation-dna.test.ts
// Tests for Conversation DNA: topic hint extraction, DNA accumulation, and
// DNA-powered handoff summaries.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    extractTopicHint,
    setStorage,
    recordTurn,
    getConversation,
    MAX_DNA_HINTS,
    type StorageArea,
    type TurnRecord,
} from '../../lib/conversation-store';
import { buildHandoffSummary, deduplicateHints } from '../../lib/handoff-summary';
import type { HealthScore } from '../../lib/health-score';

const TEST_ORG = 'org-test-123';

// ── Storage mock ──────────────────────────────────────────────────────────────

function createStoreMock(): StorageArea & { _raw: Record<string, unknown> } {
    const data: Record<string, unknown> = {};
    return {
        get: vi.fn(async (keys: string | string[] | null) => {
            if (keys === null) return { ...data };
            const keyList = typeof keys === 'string' ? [keys] : keys;
            const result: Record<string, unknown> = {};
            for (const k of keyList) {
                if (k in data) result[k] = data[k];
            }
            return result;
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
            Object.assign(data, items);
        }),
        remove: vi.fn(async (keys: string | string[]) => {
            const keyList = typeof keys === 'string' ? [keys] : keys;
            for (const k of keyList) delete data[k];
        }),
        _raw: data,
    };
}

function makeTurn(overrides: Partial<Omit<TurnRecord, 'turnNumber'>> = {}): Omit<TurnRecord, 'turnNumber'> {
    return {
        inputTokens: 1000,
        outputTokens: 200,
        model: 'claude-sonnet-4-6',
        contextPct: 5,
        cost: 0.006,
        completedAt: Date.now(),
        ...overrides,
    };
}

function makeHealth(level: 'healthy' | 'degrading' | 'critical'): HealthScore {
    return {
        level,
        label: level.charAt(0).toUpperCase() + level.slice(1),
        coaching: 'test coaching',
        contextPct: 50,
    };
}

let mockStore: ReturnType<typeof createStoreMock>;

beforeEach(() => {
    mockStore = createStoreMock();
    setStorage(mockStore);
});

// ── extractTopicHint ──────────────────────────────────────────────────────────

describe('extractTopicHint', () => {
    it('returns the first meaningful line', () => {
        expect(extractTopicHint('Can you help me set up OAuth2 for my Express app?'))
            .toBe('Can you help me set up OAuth2 for my Express app?');
    });

    it('skips greetings and returns the substantive line', () => {
        const prompt = 'Hey\nCan you help me fix the token refresh bug?';
        expect(extractTopicHint(prompt)).toBe('Can you help me fix the token refresh bug?');
    });

    it('skips short lines', () => {
        const prompt = 'OK\nSure\nLet me explain the market entry strategy for Japan';
        expect(extractTopicHint(prompt)).toBe('Let me explain the market entry strategy for Japan');
    });

    it('skips code fences', () => {
        const prompt = '```typescript\nconst x = 1;\n```\nPlease review this code and suggest improvements';
        expect(extractTopicHint(prompt)).toBe('Please review this code and suggest improvements');
    });

    it('truncates long lines to MAX_HINT_CHARS', () => {
        const longLine = 'A'.repeat(200);
        const result = extractTopicHint(longLine);
        expect(result.length).toBeLessThanOrEqual(124); // 120 + "..."
        expect(result.endsWith('...')).toBe(true);
    });

    it('returns empty string for empty input', () => {
        expect(extractTopicHint('')).toBe('');
    });

    it('falls back to first non-empty line if all are greetings', () => {
        const prompt = 'Hey\nHello\nHi there';
        // "Hey" and "Hello" are <10 chars, "Hi there" is <10. All fail first pass.
        // Fallback returns first non-empty: "Hey"
        expect(extractTopicHint(prompt)).toBe('Hey');
    });

    it('handles "thanks" prefix gracefully', () => {
        const prompt = 'Thanks for that!\nNow can you also add error handling?';
        expect(extractTopicHint(prompt)).toBe('Now can you also add error handling?');
    });

    it('works with non-code, non-technical prompts', () => {
        expect(extractTopicHint('What are the best strategies for reducing customer churn in SaaS?'))
            .toBe('What are the best strategies for reducing customer churn in SaaS?');
    });

    it('works with creative writing prompts', () => {
        expect(extractTopicHint('Write a short story about a lighthouse keeper who discovers a message in a bottle'))
            .toBe('Write a short story about a lighthouse keeper who discovers a message in a bottle');
    });
});

// ── DNA accumulation via recordTurn ───────────────────────────────────────────

describe('DNA accumulation', () => {
    const CONV_ID = 'dna-test-conv';

    it('sets subject and lastContext on first turn', async () => {
        await recordTurn(TEST_ORG, CONV_ID, makeTurn(), 'Set up OAuth2 for Express');
        const conv = await getConversation(TEST_ORG, CONV_ID);
        expect(conv!.dna.subject).toBe('Set up OAuth2 for Express');
        expect(conv!.dna.lastContext).toBe('Set up OAuth2 for Express');
        expect(conv!.dna.hints).toEqual(['Set up OAuth2 for Express']);
    });

    it('updates lastContext but keeps original subject on subsequent turns', async () => {
        await recordTurn(TEST_ORG, CONV_ID, makeTurn(), 'Set up OAuth2 for Express');
        await recordTurn(TEST_ORG, CONV_ID, makeTurn(), 'Debug the token refresh endpoint');
        const conv = await getConversation(TEST_ORG, CONV_ID);
        expect(conv!.dna.subject).toBe('Set up OAuth2 for Express');
        expect(conv!.dna.lastContext).toBe('Debug the token refresh endpoint');
    });

    it('stores hints newest-first', async () => {
        await recordTurn(TEST_ORG, CONV_ID, makeTurn(), 'First topic');
        await recordTurn(TEST_ORG, CONV_ID, makeTurn(), 'Second topic');
        await recordTurn(TEST_ORG, CONV_ID, makeTurn(), 'Third topic');
        const conv = await getConversation(TEST_ORG, CONV_ID);
        expect(conv!.dna.hints[0]).toBe('Third topic');
        expect(conv!.dna.hints[2]).toBe('First topic');
    });

    it('caps hints at MAX_DNA_HINTS', async () => {
        for (let i = 0; i < MAX_DNA_HINTS + 5; i++) {
            await recordTurn(TEST_ORG, CONV_ID, makeTurn(), `Topic ${i}`);
        }
        const conv = await getConversation(TEST_ORG, CONV_ID);
        expect(conv!.dna.hints).toHaveLength(MAX_DNA_HINTS);
        // Newest should be last recorded
        expect(conv!.dna.hints[0]).toBe(`Topic ${MAX_DNA_HINTS + 4}`);
    });

    it('handles turns without topic hints gracefully', async () => {
        await recordTurn(TEST_ORG, CONV_ID, makeTurn(), 'Initial question');
        await recordTurn(TEST_ORG, CONV_ID, makeTurn()); // no topicHint
        await recordTurn(TEST_ORG, CONV_ID, makeTurn(), 'Follow-up question');
        const conv = await getConversation(TEST_ORG, CONV_ID);
        expect(conv!.dna.hints).toHaveLength(2);
        expect(conv!.dna.lastContext).toBe('Follow-up question');
    });

    it('handles conversation with no hints at all', async () => {
        await recordTurn(TEST_ORG, CONV_ID, makeTurn()); // no hint
        await recordTurn(TEST_ORG, CONV_ID, makeTurn()); // no hint
        const conv = await getConversation(TEST_ORG, CONV_ID);
        expect(conv!.dna.subject).toBe('');
        expect(conv!.dna.hints).toHaveLength(0);
    });
});

// ── deduplicateHints ──────────────────────────────────────────────────────────

describe('deduplicateHints', () => {
    it('removes near-duplicates (same first 40 chars)', () => {
        const hints = [
            'Debug the token refresh endpoint returning 401',
            'Debug the token refresh endpoint with httpOnly cookies',
            'Set up OAuth2 for Express',
        ];
        const result = deduplicateHints(hints);
        expect(result).toHaveLength(2);
    });

    it('preserves order (newest first)', () => {
        const hints = ['Third', 'Second', 'First'];
        expect(deduplicateHints(hints)).toEqual(['Third', 'Second', 'First']);
    });

    it('is case-insensitive for dedup', () => {
        const hints = [
            'Debug the token refresh endpoint returning 401 error',
            'debug the token refresh endpoint with new approach',
        ];
        expect(deduplicateHints(hints)).toHaveLength(1);
    });

    it('handles empty array', () => {
        expect(deduplicateHints([])).toEqual([]);
    });
});

// ── DNA-powered handoff summary ───────────────────────────────────────────────

describe('DNA-powered buildHandoffSummary', () => {
    it('includes topic progression when DNA has hints', async () => {
        await recordTurn(TEST_ORG, 'conv-1', makeTurn(), 'Set up OAuth2 for Express');
        await recordTurn(TEST_ORG, 'conv-1', makeTurn(), 'Design the database schema for sessions');
        await recordTurn(TEST_ORG, 'conv-1', makeTurn(), 'Debug token refresh returning 401');
        const conv = await getConversation(TEST_ORG, 'conv-1');

        const summary = buildHandoffSummary({
            conversation: conv!,
            health: makeHealth('degrading'),
        });

        expect(summary).toContain('Started with: Set up OAuth2 for Express');
        expect(summary).toContain('Last working on: Debug token refresh returning 401');
        expect(summary).toContain('What we covered:');
        expect(summary).toContain('- Set up OAuth2 for Express');
        expect(summary).toContain('- Design the database schema for sessions');
        expect(summary).toContain('- Debug token refresh returning 401');
    });

    it('shows topics in chronological order (oldest first)', async () => {
        await recordTurn(TEST_ORG, 'conv-1', makeTurn(), 'First topic');
        await recordTurn(TEST_ORG, 'conv-1', makeTurn(), 'Second topic');
        await recordTurn(TEST_ORG, 'conv-1', makeTurn(), 'Third topic');
        const conv = await getConversation(TEST_ORG, 'conv-1');

        const summary = buildHandoffSummary({
            conversation: conv!,
            health: makeHealth('degrading'),
        });

        const firstIdx = summary.indexOf('First topic');
        const thirdIdx = summary.indexOf('Third topic');
        expect(firstIdx).toBeLessThan(thirdIdx);
    });

    it('falls back gracefully when DNA is empty', async () => {
        await recordTurn(TEST_ORG, 'conv-1', makeTurn()); // no hint
        const conv = await getConversation(TEST_ORG, 'conv-1');

        const summary = buildHandoffSummary({
            conversation: conv!,
            health: makeHealth('degrading'),
        });

        // Should still have the metadata line, just no topic section.
        expect(summary).toContain('1 turn');
        expect(summary).not.toContain('What we covered:');
    });

    it('works for non-technical conversations', async () => {
        await recordTurn(TEST_ORG, 'conv-1', makeTurn(), 'What are the best strategies for reducing customer churn?');
        await recordTurn(TEST_ORG, 'conv-1', makeTurn(), 'How do I calculate net revenue retention?');
        await recordTurn(TEST_ORG, 'conv-1', makeTurn(), 'Can you draft an email to at-risk customers?');
        const conv = await getConversation(TEST_ORG, 'conv-1');

        const summary = buildHandoffSummary({
            conversation: conv!,
            health: makeHealth('critical'),
        });

        expect(summary).toContain('reducing customer churn');
        expect(summary).toContain('net revenue retention');
        expect(summary).toContain('email to at-risk customers');
        expect(summary).toContain('context window was nearly full');
    });
});
