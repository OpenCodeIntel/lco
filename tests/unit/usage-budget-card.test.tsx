// @vitest-environment happy-dom
//
// Render tests for the side-panel Usage Budget card. These cover the three
// branches that satisfy GET-20 acceptance criteria directly:
//
//   AC #1 — Enterprise (credit) tab shows monthly spend bar
//   AC #2 — Pro/Personal (session) tab keeps the existing two-bar layout
//   AC #3 — Teams / unrecognized tier shows "Saar can't read..." empty state
//
// The agent layer (lib/usage-budget.ts) tests verify the math, formatting,
// and zone classification. This file verifies the JSX actually renders the
// fields the agent produces — a small typo in the card would otherwise
// regress an acceptance criterion silently.

import { describe, it, expect } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import UsageBudgetCard from '../../entrypoints/sidepanel/components/UsageBudgetCard';
import type { UsageBudgetSession, UsageBudgetCredit, UsageBudgetResult } from '../../lib/message-types';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function sessionBudget(overrides: Partial<UsageBudgetSession> = {}): UsageBudgetSession {
    return {
        kind: 'session',
        sessionPct: 22,
        weeklyPct: 14,
        sessionMinutesUntilReset: 73,
        weeklyResetLabel: 'Wed 9:00 AM',
        zone: 'comfortable',
        statusLabel: '22% used; resets in 1h 13m',
        ...overrides,
    };
}

// Anchored on Devanshu's Northeastern Enterprise account (2026-04-23).
function creditBudget(overrides: Partial<UsageBudgetCredit> = {}): UsageBudgetCredit {
    return {
        kind: 'credit',
        monthlyLimitCents: 50000,
        usedCents: 30491,
        utilizationPct: 60.982,
        currency: 'USD',
        resetLabel: 'Resets May 1',
        zone: 'moderate',
        statusLabel: '$304.91 of $500.00 spent',
        ...overrides,
    };
}

// ── Empty states ─────────────────────────────────────────────────────────────

describe('UsageBudgetCard — empty states', () => {
    it('prompts the user to open claude.ai when off-tab and budget is null', () => {
        render(<UsageBudgetCard budget={null} isClaudeTab={false} />);
        expect(screen.getByText('Open claude.ai to load usage data')).toBeTruthy();
    });

    it('shows the "account type not supported" message when on-tab but budget is null', () => {
        // null on a Claude tab means the fetch failed before the parser could
        // classify anything; we still tell the user we cannot read their account
        // rather than nudge them somewhere they already are.
        render(<UsageBudgetCard budget={null} isClaudeTab={true} />);
        expect(screen.getByText(/can't read usage on this account type/i)).toBeTruthy();
    });

    it('shows the "account type not supported" message on the unsupported variant', () => {
        const unsupported: UsageBudgetResult = { kind: 'unsupported' };
        render(<UsageBudgetCard budget={unsupported} isClaudeTab={true} />);
        expect(screen.getByText(/can't read usage on this account type/i)).toBeTruthy();
    });
});

// ── Session variant (Pro / Personal / Max) ───────────────────────────────────
// AC #2: Pro/Personal accounts must see the existing session + weekly layout
// with no regression.

describe('UsageBudgetCard — session variant', () => {
    it('renders the session and weekly bars side by side', () => {
        render(<UsageBudgetCard budget={sessionBudget()} isClaudeTab={true} />);
        expect(screen.getByText('Session')).toBeTruthy();
        expect(screen.getByText('Weekly')).toBeTruthy();
    });

    it('shows the agent-provided status label as the primary line', () => {
        const budget = sessionBudget({ statusLabel: '22% used; resets in 1h 13m' });
        render(<UsageBudgetCard budget={budget} isClaudeTab={true} />);
        expect(screen.getByText('22% used; resets in 1h 13m')).toBeTruthy();
    });

    it('shows the rounded session and weekly percentages', () => {
        const budget = sessionBudget({ sessionPct: 22, weeklyPct: 14 });
        render(<UsageBudgetCard budget={budget} isClaudeTab={true} />);
        expect(screen.getByText('22%')).toBeTruthy();
        expect(screen.getByText('14%')).toBeTruthy();
    });

    it('exposes both reset lines (session countdown + weekly label)', () => {
        const budget = sessionBudget({ sessionMinutesUntilReset: 73, weeklyResetLabel: 'Wed 9:00 AM' });
        render(<UsageBudgetCard budget={budget} isClaudeTab={true} />);
        // "73 min" formats to "1h 13m" inside the card.
        expect(screen.getByText(/Session resets in 1h 13m/)).toBeTruthy();
        expect(screen.getByText(/Weekly resets Wed 9:00 AM/)).toBeTruthy();
    });

    it('does not render the Enterprise pill on the session variant', () => {
        render(<UsageBudgetCard budget={sessionBudget()} isClaudeTab={true} />);
        expect(screen.queryByText('Enterprise')).toBeNull();
    });
});

// ── Credit variant (Enterprise) ──────────────────────────────────────────────
// AC #1: Enterprise must see the monthly spend bar with $X of $Y · Resets {date}
// and the correct utilization %, not the "Open claude.ai" prompt.

describe('UsageBudgetCard — credit variant', () => {
    it('shows the "Enterprise" tier pill in the header', () => {
        render(<UsageBudgetCard budget={creditBudget()} isClaudeTab={true} />);
        expect(screen.getByText('Enterprise')).toBeTruthy();
    });

    it('shows the agent-provided spend status label', () => {
        render(<UsageBudgetCard budget={creditBudget()} isClaudeTab={true} />);
        expect(screen.getByText('$304.91 of $500.00 spent')).toBeTruthy();
    });

    it('shows a single Monthly bar (no Session, no Weekly)', () => {
        render(<UsageBudgetCard budget={creditBudget()} isClaudeTab={true} />);
        expect(screen.getByText('Monthly')).toBeTruthy();
        expect(screen.queryByText('Session')).toBeNull();
        expect(screen.queryByText('Weekly')).toBeNull();
    });

    it('renders the rounded utilization percentage', () => {
        // 60.982 rounds to 61.
        render(<UsageBudgetCard budget={creditBudget()} isClaudeTab={true} />);
        expect(screen.getByText('61%')).toBeTruthy();
    });

    it('shows the agent-provided reset label', () => {
        render(<UsageBudgetCard budget={creditBudget({ resetLabel: 'Resets May 1' })} isClaudeTab={true} />);
        expect(screen.getByText('Resets May 1')).toBeTruthy();
    });

    it('does not show the "Open claude.ai" prompt when budget is present', () => {
        // Direct regression guard for the original GET-20 bug: Enterprise users
        // saw the empty-state placeholder instead of their actual spend.
        render(<UsageBudgetCard budget={creditBudget()} isClaudeTab={true} />);
        expect(screen.queryByText(/Open claude.ai/)).toBeNull();
    });
});
