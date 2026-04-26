// @vitest-environment happy-dom
//
// Tests for the "this reply" delta label in ui/overlay.ts. The label says
// "X% of session" on Pro/Personal accounts and "X% of monthly" on Enterprise,
// because lastDeltaUtilization is tracked in tier-appropriate units
// (5-hour session window vs monthly credit pool).
//
// Locks in Option B from the GET-20 plan: the underlying number is correct
// for both tiers, but the wording would mislead an Enterprise user if it
// hard-coded "session".

import { describe, it, expect, beforeEach } from 'vitest';
import { createOverlay } from '../../ui/overlay';
import { INITIAL_STATE, applyUsageBudget } from '../../lib/overlay-state';
import type { OverlayState } from '../../lib/overlay-state';
import type { UsageBudgetSession, UsageBudgetCredit } from '../../lib/message-types';

function mountOverlay() {
    const overlay = createOverlay();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    overlay.mount(shadow);
    overlay.render(INITIAL_STATE);
    return { overlay, shadow };
}

function getThisReplyText(shadow: ShadowRoot): string {
    // The "this reply" value is the second .lco-value (first is the draft
    // estimate, hidden when there is no draft); it carries the lco-accent
    // modifier, which is unique on the line.
    const node = shadow.querySelector<HTMLElement>('.lco-value.lco-accent');
    return node?.textContent ?? '';
}

const sessionBudget: UsageBudgetSession = {
    kind: 'session',
    sessionPct: 12,
    weeklyPct: 4,
    sessionMinutesUntilReset: 120,
    weeklyResetLabel: 'Wed 9:00 AM',
    zone: 'comfortable',
    statusLabel: '12% used; resets in 2h',
};

const creditBudget: UsageBudgetCredit = {
    kind: 'credit',
    monthlyLimitCents: 50000,
    usedCents: 30491,
    utilizationPct: 60.982,
    currency: 'USD',
    resetLabel: 'Resets May 1',
    zone: 'moderate',
    statusLabel: '$304.91 of $500.00 spent',
};

function stateWithDelta(budget: UsageBudgetSession | UsageBudgetCredit, delta: number): OverlayState {
    // applyUsageBudget gives us the right kind on state. We then lay the
    // standard "reply landed" fields on top so the overlay reveals the row.
    return {
        ...applyUsageBudget(INITIAL_STATE, budget),
        lastRequest: { inputTokens: 1200, outputTokens: 350, model: 'claude-sonnet-4-6', cost: 0.0089 },
        lastDeltaUtilization: delta,
    };
}

beforeEach(() => {
    document.body.innerHTML = '';
});

describe('overlay "this reply" delta label', () => {
    it('says "% of session" when the budget is the session variant', () => {
        const { overlay, shadow } = mountOverlay();
        overlay.render(stateWithDelta(sessionBudget, 1.7));
        const text = getThisReplyText(shadow);
        expect(text).toContain('1.7% of session');
        expect(text).not.toContain('monthly');
    });

    it('says "% of monthly" when the budget is the credit variant', () => {
        // Locks in the Option B contract: Enterprise users see the right unit.
        const { overlay, shadow } = mountOverlay();
        overlay.render(stateWithDelta(creditBudget, 0.4));
        const text = getThisReplyText(shadow);
        expect(text).toContain('0.4% of monthly');
        expect(text).not.toContain('session');
    });

    it('falls back to token/cost text when no delta has resolved yet', () => {
        // Sanity: the label switch is gated on lastDeltaUtilization !== null.
        // With no delta we still get the legacy display, regardless of tier.
        const { overlay, shadow } = mountOverlay();
        overlay.render({
            ...applyUsageBudget(INITIAL_STATE, creditBudget),
            lastRequest: { inputTokens: 1200, outputTokens: 350, model: 'claude-sonnet-4-6', cost: 0.0089 },
            // lastDeltaUtilization stays null — first turn, no before-snapshot.
        });
        const text = getThisReplyText(shadow);
        expect(text).toContain('1,200 in');
        expect(text).toContain('350 out');
        expect(text).not.toContain('monthly');
        expect(text).not.toContain('session');
    });
});
