import { describe, test, expect } from 'vitest';

// Audit: lib/usage-budget.ts - zone classification, budget computation

import { classifyZone, computeUsageBudget } from '../../lib/usage-budget';
import type { UsageLimitsData } from '../../lib/message-types';

// ── classifyZone ───────────────────────────────────────────────────────────

describe('classifyZone', () => {
    test('comfortable below 50%', () => {
        expect(classifyZone(0)).toBe('comfortable');
        expect(classifyZone(49.9)).toBe('comfortable');
    });

    test('moderate at 50-74%', () => {
        expect(classifyZone(50)).toBe('moderate');
        expect(classifyZone(74.9)).toBe('moderate');
    });

    test('tight at 75-89%', () => {
        expect(classifyZone(75)).toBe('tight');
        expect(classifyZone(89.9)).toBe('tight');
    });

    test('critical at 90%+', () => {
        expect(classifyZone(90)).toBe('critical');
        expect(classifyZone(100)).toBe('critical');
    });
});

// ── computeUsageBudget ─────────────────────────────────────────────────────

describe('computeUsageBudget', () => {
    const now = new Date('2026-04-13T12:00:00Z').getTime();

    function makeLimits(overrides: Partial<{
        sessionUtil: number;
        weeklyUtil: number;
        sessionResetsAt: string;
        weeklyResetsAt: string;
    }> = {}): UsageLimitsData {
        return {
            fiveHour: {
                utilization: overrides.sessionUtil ?? 20,
                resetsAt: overrides.sessionResetsAt ?? '2026-04-13T14:00:00Z',
            },
            sevenDay: {
                utilization: overrides.weeklyUtil ?? 10,
                resetsAt: overrides.weeklyResetsAt ?? '2026-04-16T00:00:00Z',
            },
        } as UsageLimitsData;
    }

    test('basic output shape', () => {
        const result = computeUsageBudget(makeLimits(), now);
        expect(result.sessionPct).toBe(20);
        expect(result.weeklyPct).toBe(10);
        expect(typeof result.sessionMinutesUntilReset).toBe('number');
        expect(typeof result.weeklyResetLabel).toBe('string');
        expect(typeof result.zone).toBe('string');
        expect(typeof result.statusLabel).toBe('string');
    });

    test('zone is driven by the max of session and weekly', () => {
        const result = computeUsageBudget(makeLimits({ sessionUtil: 30, weeklyUtil: 80 }), now);
        expect(result.zone).toBe('tight'); // 80% => tight
    });

    test('session minutes calculation', () => {
        // Reset at 14:00, now at 12:00 -> 120 minutes
        const result = computeUsageBudget(makeLimits(), now);
        expect(result.sessionMinutesUntilReset).toBe(120);
    });

    test('session minutes never negative', () => {
        // Reset time in the past
        const result = computeUsageBudget(makeLimits({
            sessionResetsAt: '2026-04-13T11:00:00Z',
        }), now);
        expect(result.sessionMinutesUntilReset).toBe(0);
    });

    test('status label for comfortable zone', () => {
        const result = computeUsageBudget(makeLimits({ sessionUtil: 11 }), now);
        expect(result.statusLabel).toMatch(/11% used/);
        expect(result.statusLabel).toMatch(/resets in/);
    });

    test('status label for critical zone', () => {
        const result = computeUsageBudget(makeLimits({ sessionUtil: 94, weeklyUtil: 94 }), now);
        expect(result.statusLabel).toMatch(/94% used/);
        expect(result.statusLabel).toMatch(/nearly exhausted/);
    });
});
