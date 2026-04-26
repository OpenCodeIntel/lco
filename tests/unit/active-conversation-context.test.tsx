// @vitest-environment happy-dom
//
// Render tests for ActiveConversation's context-bar percent computation.
// The percent is now derived from cumulative tokens against the model's
// context window, not from record.lastContextPct. The reason matters:
// some records were written with lastContextPct in fractional units
// (0.026 instead of 2.6), which rendered as a flat zero bar even when
// the conversation was well underway.
//
// These tests pin the recompute behavior so a future refactor doesn't
// silently fall back to the stale field.

import { describe, it, expect } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import ActiveConversation from '../../entrypoints/sidepanel/components/ActiveConversation';
import type { ConversationRecord } from '../../lib/conversation-store';

function makeConv(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
    return {
        id: 'conv-test',
        startedAt: 1_700_000_000_000,
        lastActiveAt: 1_700_000_001_000,
        finalized: false,
        turnCount: 8,
        totalInputTokens: 4000,
        totalOutputTokens: 1192,
        peakContextPct: 0.026,
        lastContextPct: 0.026, // stored in fractional units (legacy bug shape)
        model: 'claude-haiku-4-5',
        estimatedCost: 0.03,
        turns: [],
        dna: { subject: 'whats going on man', lastContext: '', hints: [] },
        _v: 1,
        ...overrides,
    };
}

describe('ActiveConversation — context% computed from tokens', () => {
    it('ignores a fractional lastContextPct and recomputes from tokens', () => {
        // 5,192 tokens / 200,000 = 2.596% -> rounds to 3%.
        // If the component fell back to the stored 0.026 field, it would
        // round to 0% and the bar would visibly be empty (the original bug).
        render(<ActiveConversation conv={makeConv()} health={null} budget={null} />);
        expect(screen.getByText('3% context')).toBeTruthy();
    });

    it('scales with token count for the same model', () => {
        const conv = makeConv({
            totalInputTokens: 50_000,
            totalOutputTokens: 50_000,
        });
        // 100k of 200k = 50%.
        render(<ActiveConversation conv={conv} health={null} budget={null} />);
        expect(screen.getByText('50% context')).toBeTruthy();
    });

    it('clamps at 100% when tokens exceed the window', () => {
        const conv = makeConv({
            totalInputTokens: 300_000,
            totalOutputTokens: 0,
        });
        render(<ActiveConversation conv={conv} health={null} budget={null} />);
        expect(screen.getByText('100% context')).toBeTruthy();
    });

    it('renders 0% on an empty conversation without throwing', () => {
        const conv = makeConv({
            totalInputTokens: 0,
            totalOutputTokens: 0,
            turnCount: 0,
        });
        render(<ActiveConversation conv={conv} health={null} budget={null} />);
        expect(screen.getByText('0% context')).toBeTruthy();
    });
});
