// @vitest-environment happy-dom
// Tests for the weekly cap bar in ui/overlay.ts.
//
// Validates: render visibility, fill transform, zone class, label text,
// and the invariant that the overlay and side panel derive the same weeklyPct
// from the same UsageLimitsData snapshot.

import { describe, it, expect, beforeEach } from 'vitest';
import { createOverlay } from '../../ui/overlay';
import { INITIAL_STATE, applyUsageBudget, applyWeeklyEta } from '../../lib/overlay-state';
import { computeUsageBudget, classifyZone } from '../../lib/usage-budget';
import type { UsageLimitsData, UsageBudgetSession, UsageBudgetCredit, BudgetZone } from '../../lib/message-types';
import type { WeeklyEta } from '../../lib/weekly-cap-eta';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const NOW = new Date('2026-04-07T00:00:00.000Z').getTime();

function makeLimits(sessionPct: number, weeklyPct: number): UsageLimitsData {
    return {
        kind: 'session',
        fiveHour: {
            utilization: sessionPct,
            resetsAt: new Date(NOW + 60 * 60000).toISOString(),
        },
        sevenDay: {
            utilization: weeklyPct,
            resetsAt: new Date('2026-04-08T09:00:00.000Z').toISOString(),
        },
        capturedAt: NOW,
    };
}

function makeBudget(weeklyPct: number, zone: BudgetZone = 'comfortable'): UsageBudgetSession {
    return {
        kind: 'session',
        sessionPct: 10,
        weeklyPct,
        sessionMinutesUntilReset: 60,
        weeklyResetLabel: 'Wed 9:00 AM',
        zone,
        statusLabel: `10% used; resets in 1h`,
    };
}

function mountOverlay() {
    const overlay = createOverlay();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    overlay.mount(shadow);
    overlay.render(INITIAL_STATE);
    return { overlay, shadow };
}

function getWeeklyRow(shadow: ShadowRoot): HTMLElement | null {
    return shadow.querySelector('.lco-weekly-row');
}

function getWeeklyFill(shadow: ShadowRoot): HTMLElement | null {
    return shadow.querySelector('.lco-weekly-row .lco-bar-fill');
}

function getWeeklyLabel(shadow: ShadowRoot): HTMLElement | null {
    return shadow.querySelector('.lco-weekly-row .lco-bar-label');
}

beforeEach(() => {
    document.body.innerHTML = '';
});

// ── Visibility ────────────────────────────────────────────────────────────────

describe('weekly bar visibility', () => {
    it('is hidden when usageBudget is null', () => {
        const { shadow } = mountOverlay();
        const row = getWeeklyRow(shadow);
        expect(row).not.toBeNull();
        expect(row!.style.display).toBe('none');
    });

    it('is visible when usageBudget is set', () => {
        const { overlay, shadow } = mountOverlay();
        const budget = makeBudget(71, 'moderate');
        const state = applyUsageBudget(INITIAL_STATE, budget);
        overlay.render(state);
        expect(getWeeklyRow(shadow)!.style.display).not.toBe('none');
    });

    it('hides again when usageBudget returns to null via re-render', () => {
        const { overlay, shadow } = mountOverlay();
        const budget = makeBudget(71, 'moderate');
        overlay.render(applyUsageBudget(INITIAL_STATE, budget));
        overlay.render(INITIAL_STATE);
        expect(getWeeklyRow(shadow)!.style.display).toBe('none');
    });
});

// ── Fill transform ────────────────────────────────────────────────────────────

describe('weekly bar fill transform', () => {
    it('sets scaleX to weeklyPct / 100', () => {
        const { overlay, shadow } = mountOverlay();
        overlay.render(applyUsageBudget(INITIAL_STATE, makeBudget(71)));
        expect(getWeeklyFill(shadow)!.style.transform).toBe('scaleX(0.71)');
    });

    it('clamps fill to 1.0 at 100%', () => {
        const { overlay, shadow } = mountOverlay();
        overlay.render(applyUsageBudget(INITIAL_STATE, makeBudget(100, 'critical')));
        expect(getWeeklyFill(shadow)!.style.transform).toBe('scaleX(1)');
    });

    it('clamps fill to 0 at 0%', () => {
        const { overlay, shadow } = mountOverlay();
        overlay.render(applyUsageBudget(INITIAL_STATE, makeBudget(0, 'comfortable')));
        expect(getWeeklyFill(shadow)!.style.transform).toBe('scaleX(0)');
    });
});

// ── Zone class ────────────────────────────────────────────────────────────────

describe('weekly bar zone class', () => {
    it('applies --comfortable class at 30%', () => {
        const { overlay, shadow } = mountOverlay();
        overlay.render(applyUsageBudget(INITIAL_STATE, makeBudget(30, 'comfortable')));
        expect(getWeeklyFill(shadow)!.classList.contains('lco-bar-fill--comfortable')).toBe(true);
    });

    it('applies --moderate class at 60%', () => {
        const { overlay, shadow } = mountOverlay();
        overlay.render(applyUsageBudget(INITIAL_STATE, makeBudget(60, 'moderate')));
        expect(getWeeklyFill(shadow)!.classList.contains('lco-bar-fill--moderate')).toBe(true);
    });

    it('applies --tight class at 80%', () => {
        const { overlay, shadow } = mountOverlay();
        overlay.render(applyUsageBudget(INITIAL_STATE, makeBudget(80, 'tight')));
        expect(getWeeklyFill(shadow)!.classList.contains('lco-bar-fill--tight')).toBe(true);
    });

    it('applies --critical class at 92%', () => {
        const { overlay, shadow } = mountOverlay();
        overlay.render(applyUsageBudget(INITIAL_STATE, makeBudget(92, 'critical')));
        expect(getWeeklyFill(shadow)!.classList.contains('lco-bar-fill--critical')).toBe(true);
    });

    it('zone class uses classifyZone(weeklyPct), not the overall budget zone', () => {
        // Budget zone is driven by max(session, weekly). Weekly bar colors itself
        // on weekly alone, matching the UsageBudgetCard.tsx convention.
        const { overlay, shadow } = mountOverlay();
        // sessionPct=95 (critical overall) but weeklyPct=30 (comfortable).
        const budget: UsageBudgetSession = {
            kind: 'session',
            sessionPct: 95,
            weeklyPct: 30,
            sessionMinutesUntilReset: 5,
            weeklyResetLabel: 'Wed 9:00 AM',
            zone: 'critical',
            statusLabel: '95% used; session nearly exhausted',
        };
        overlay.render(applyUsageBudget(INITIAL_STATE, budget));
        const fill = getWeeklyFill(shadow)!;
        expect(fill.classList.contains('lco-bar-fill--comfortable')).toBe(true);
        expect(fill.classList.contains('lco-bar-fill--critical')).toBe(false);
    });

    // ── Tier-variant gating (GET-20) ──────────────────────────────────────────
    // The weekly bar belongs only to the session tier. Credit (Enterprise)
    // budgets must keep it hidden; unsupported budgets never reach overlay
    // state at all (the content script gates them out, and the type system
    // rejects them at applyUsageBudget), so they cannot be tested here.

    it('is hidden when the budget is the credit (Enterprise) variant', () => {
        const { overlay, shadow } = mountOverlay();
        const credit: UsageBudgetCredit = {
            kind: 'credit',
            monthlyLimitCents: 50000,
            usedCents: 30491,
            utilizationPct: 60.982,
            currency: 'USD',
            resetLabel: 'Resets May 1',
            zone: 'moderate',
            statusLabel: '$304.91 of $500.00 spent',
        };
        overlay.render(applyUsageBudget(INITIAL_STATE, credit));
        expect(getWeeklyRow(shadow)!.style.display).toBe('none');
    });
});

// ── Label text ────────────────────────────────────────────────────────────────

describe('weekly bar label', () => {
    it('shows rounded percentage with "weekly" suffix', () => {
        const { overlay, shadow } = mountOverlay();
        overlay.render(applyUsageBudget(INITIAL_STATE, makeBudget(71)));
        expect(getWeeklyLabel(shadow)!.textContent).toBe('71% weekly');
    });

    it('rounds fractional percentages', () => {
        const { overlay, shadow } = mountOverlay();
        overlay.render(applyUsageBudget(INITIAL_STATE, makeBudget(71.6)));
        expect(getWeeklyLabel(shadow)!.textContent).toBe('72% weekly');
    });
});

// ── Invariant: overlay weeklyPct equals side-panel weeklyPct ──────────────────

describe('overlay/side-panel weeklyPct invariant', () => {
    it('both surfaces read weeklyPct from the same computeUsageBudget call path', () => {
        const limits = makeLimits(12, 71);
        const budget = computeUsageBudget(limits, NOW);
        if (budget.kind !== 'session') throw new Error('expected session');
        // weeklyPct is a direct pass-through of sevenDay.utilization — no transformation.
        expect(budget.weeklyPct).toBe(71);
        // The overlay will call applyUsageBudget(state, budget), which stores this value.
        // The side panel calls computeUsageBudget(limits, Date.now()) in useDashboardData.ts.
        // Both derive from the same source data; the weeklyPct is always equal.
        const state = applyUsageBudget(INITIAL_STATE, budget);
        if (state.usageBudget?.kind !== 'session') throw new Error('expected session');
        expect(state.usageBudget.weeklyPct).toBe(budget.weeklyPct);
    });

    it('zone classification agrees for the same weeklyPct', () => {
        const limits = makeLimits(10, 71);
        const budget = computeUsageBudget(limits, NOW);
        if (budget.kind !== 'session') throw new Error('expected session');
        // The overlay bar uses classifyZone(weeklyPct) directly.
        // The side panel UsageBudgetCard uses classifyZone(weeklyPct) for the weekly fill.
        // Both reference the same exported function with the same input.
        expect(classifyZone(budget.weeklyPct)).toBe('moderate');
    });
});

// ── Weekly ETA label in overlay (GET-21) ─────────────────────────────────────

function getEtaEl(shadow: ShadowRoot): HTMLElement | null {
    return shadow.querySelector('.lco-weekly-eta');
}

function makeEta(etaTimestamp: number, confidence: WeeklyEta['confidence'] = 'high'): WeeklyEta {
    return { etaTimestamp, hoursRemaining: 6, confidence };
}

describe('overlay ETA label', () => {
    it('ETA element is present in the DOM after mount', () => {
        const { shadow } = mountOverlay();
        expect(getEtaEl(shadow)).not.toBeNull();
    });

    it('is hidden when weeklyEta is null', () => {
        const { shadow } = mountOverlay();
        expect(getEtaEl(shadow)!.style.display).toBe('none');
    });

    it('is visible when budget is session AND weeklyEta is non-null', () => {
        const { overlay, shadow } = mountOverlay();
        const state = applyWeeklyEta(
            applyUsageBudget(INITIAL_STATE, makeBudget(50)),
            makeEta(NOW + 6 * 60 * 60 * 1000),
        );
        overlay.render(state);
        expect(getEtaEl(shadow)!.style.display).not.toBe('none');
    });

    it('shows a non-empty label containing "at this pace"', () => {
        const { overlay, shadow } = mountOverlay();
        const state = applyWeeklyEta(
            applyUsageBudget(INITIAL_STATE, makeBudget(50)),
            makeEta(NOW + 6 * 60 * 60 * 1000),
        );
        overlay.render(state);
        expect(getEtaEl(shadow)!.textContent).toMatch(/at this pace/i);
    });

    it('hides when weeklyEta is cleared back to null', () => {
        const { overlay, shadow } = mountOverlay();
        overlay.render(applyWeeklyEta(
            applyUsageBudget(INITIAL_STATE, makeBudget(50)),
            makeEta(NOW + 6 * 60 * 60 * 1000),
        ));
        overlay.render(applyWeeklyEta(
            applyUsageBudget(INITIAL_STATE, makeBudget(50)),
            null,
        ));
        expect(getEtaEl(shadow)!.style.display).toBe('none');
    });

    it('hides when budget is credit even if weeklyEta is non-null', () => {
        const { overlay, shadow } = mountOverlay();
        const credit: UsageBudgetCredit = {
            kind: 'credit',
            monthlyLimitCents: 50000,
            usedCents: 30491,
            utilizationPct: 60.982,
            currency: 'USD',
            resetLabel: 'Resets May 1',
            zone: 'moderate',
            statusLabel: '$304.91 of $500.00 spent',
        };
        const state = applyWeeklyEta(
            applyUsageBudget(INITIAL_STATE, credit),
            makeEta(NOW + 6 * 60 * 60 * 1000),
        );
        overlay.render(state);
        expect(getEtaEl(shadow)!.style.display).toBe('none');
    });
});
