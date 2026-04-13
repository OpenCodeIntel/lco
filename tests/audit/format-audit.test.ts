import { describe, test, expect } from 'vitest';

// Audit: lib/format.ts - formatting edge cases

import { formatTokens, formatCost, formatModel, formatRelativeTime } from '../../lib/format';

// ── formatTokens ───────────────────────────────────────────────────────────

describe('formatTokens', () => {
    test('below 1000 returns raw number', () => {
        expect(formatTokens(0)).toBe('0');
        expect(formatTokens(999)).toBe('999');
    });

    test('1000-999999 returns k format', () => {
        expect(formatTokens(1000)).toBe('1.0k');
        expect(formatTokens(1234)).toBe('1.2k');
        expect(formatTokens(999999)).toBe('1000.0k');
    });

    test('1M+ returns M format', () => {
        expect(formatTokens(1_000_000)).toBe('1.0M');
        expect(formatTokens(1_500_000)).toBe('1.5M');
    });

    test('NaN returns "NaN"', () => {
        expect(formatTokens(NaN)).toBe('NaN');
    });

    test('negative numbers', () => {
        // -1234 < 1000 (actually less), so returns String(-1234)
        expect(formatTokens(-1234)).toBe('-1234');
    });

    test('Infinity returns "Infinity"', () => {
        // Infinity >= 1_000_000, so (Infinity / 1_000_000).toFixed(1) = "Infinity"
        expect(formatTokens(Infinity)).toBe('InfinityM');
    });
});

// ── formatCost ─────────────────────────────────────────────────────────────

describe('formatCost', () => {
    test('null returns "$0.00*"', () => {
        expect(formatCost(null)).toBe('$0.00*');
    });

    test('zero returns "$0.00"', () => {
        expect(formatCost(0)).toBe('$0.00');
    });

    test('default 2 decimal places', () => {
        expect(formatCost(1.5)).toBe('$1.50');
    });

    test('4 decimal places', () => {
        expect(formatCost(0.0073, 4)).toBe('$0.0073');
    });

    test('large cost', () => {
        expect(formatCost(100.5)).toBe('$100.50');
    });

    test('very small cost', () => {
        expect(formatCost(0.000001, 6)).toBe('$0.000001');
    });

    test('NaN cost', () => {
        expect(formatCost(NaN)).toBe('$NaN');
    });
});

// ── formatModel ────────────────────────────────────────────────────────────

describe('formatModel', () => {
    test('formats claude-sonnet-4-6 correctly', () => {
        expect(formatModel('claude-sonnet-4-6')).toBe('Sonnet 4.6');
    });

    test('formats claude-opus-4-6 correctly', () => {
        expect(formatModel('claude-opus-4-6')).toBe('Opus 4.6');
    });

    test('formats claude-haiku-4-5 correctly', () => {
        expect(formatModel('claude-haiku-4-5')).toBe('Haiku 4.5');
    });

    test('formats versioned model with date suffix', () => {
        expect(formatModel('claude-sonnet-4-6-20250514')).toBe('Sonnet 4.6');
    });

    test('returns raw string for unknown model', () => {
        expect(formatModel('gpt-4o')).toBe('gpt-4o');
    });

    test('returns empty string for empty input', () => {
        expect(formatModel('')).toBe('');
    });
});

// ── formatRelativeTime ─────────────────────────────────────────────────────

describe('formatRelativeTime', () => {
    const now = 1712000000000; // fixed reference

    test('within 60 seconds = "just now"', () => {
        expect(formatRelativeTime(now - 30000, now)).toBe('just now');
    });

    test('at exactly 60 seconds = "1m ago"', () => {
        expect(formatRelativeTime(now - 60000, now)).toBe('1m ago');
    });

    test('minutes range', () => {
        expect(formatRelativeTime(now - 5 * 60000, now)).toBe('5m ago');
        expect(formatRelativeTime(now - 59 * 60000, now)).toBe('59m ago');
    });

    test('hours range', () => {
        expect(formatRelativeTime(now - 2 * 3600000, now)).toBe('2h ago');
        expect(formatRelativeTime(now - 23 * 3600000, now)).toBe('23h ago');
    });

    test('yesterday', () => {
        expect(formatRelativeTime(now - 25 * 3600000, now)).toBe('yesterday');
        expect(formatRelativeTime(now - 47 * 3600000, now)).toBe('yesterday');
    });

    test('older than 48h shows date', () => {
        const ts = now - 49 * 3600000;
        const result = formatRelativeTime(ts, now);
        // Should match "Mon D" format
        expect(result).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
    });

    test('future timestamp returns "just now"', () => {
        expect(formatRelativeTime(now + 10000, now)).toBe('just now');
    });
});
