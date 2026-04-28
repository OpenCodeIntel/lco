import { describe, test, expect } from 'vitest';

// Audit: Fuzz tests - adversarial and boundary inputs for all pure functions

import { lookupModel, calculateCost, getContextWindowSize } from '../../lib/pricing';
import { formatTokens, formatCost, formatModel, formatRelativeTime } from '../../lib/format';
import { computeHealthScore, computeGrowthRate } from '../../lib/health-score';
import { analyzeContext, pickTopSignal } from '../../lib/context-intelligence';
import { analyzeDelta } from '../../lib/delta-coaching';
import { analyzePrompt, classifyModelTier } from '../../lib/prompt-analysis';
import { computePreSubmitEstimate } from '../../lib/pre-submit';
import { computeTokenEconomics } from '../../lib/token-economics';
import { classifyZone } from '../../lib/usage-budget';
import { isValidBridgeSchema } from '../../lib/bridge-validation';
import {
    extractConversationId,
    extractOrganizationId,
    extractTopicHint,
    todayDateString,
    isoWeekId,
} from '../../lib/conversation-store';
import { deduplicateHints } from '../../lib/handoff-summary';

// ── Fuzz input sets ────────────────────────────────────────────────────────

const stringFuzz = [
    '', ' ', '\t', '\n', '\r\n',
    'a'.repeat(1_000_000),
    '\u0000\u0001\u0002\u001F',
    '\uD800', // lone surrogate
    '<script>alert(1)</script>',
    '{{template}}',
    '${injection}',
    'null', 'undefined', 'NaN', 'Infinity', '-Infinity',
    '{"__proto__":{"polluted":true}}',
    String.raw`data: {"type":"content_block_delta"}\n\n`,
];

const numFuzz = [
    0, -0, -1, 1, 0.5,
    NaN, Infinity, -Infinity,
    Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1,
    Number.MIN_SAFE_INTEGER,
    Number.MAX_VALUE, Number.MIN_VALUE, Number.EPSILON,
    2 ** 53, -(2 ** 53),
    1e-15, 1e15, 1e308,
    0.1 + 0.2,
];

const typeFuzz: unknown[] = [
    undefined, null, true, false,
    0, '', [], {}, () => {},
    Symbol('test'),
    new Date(), /regex/,
    new Error('error as input'),
];

// ── Helper: run function with timeout ──────────────────────────────────────

function doesNotHang(fn: () => unknown, label: string, timeoutMs = 5000): void {
    test(`${label} does not hang`, async () => {
        const result = await Promise.race([
            new Promise<'ok'>((resolve) => {
                try { fn(); } catch { /* expected */ }
                resolve('ok');
            }),
            new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), timeoutMs)),
        ]);
        expect(result).toBe('ok');
    });
}

// ── String fuzzing ─────────────────────────────────────────────────────────

describe('string fuzz: lookupModel', () => {
    for (const input of stringFuzz) {
        test(`lookupModel(${JSON.stringify(input).slice(0, 40)}) does not throw`, () => {
            expect(() => lookupModel(input)).not.toThrow();
        });
    }
});

describe('string fuzz: formatModel', () => {
    for (const input of stringFuzz) {
        test(`formatModel(${JSON.stringify(input).slice(0, 40)}) does not throw`, () => {
            expect(() => formatModel(input)).not.toThrow();
        });
    }
});

describe('string fuzz: classifyModelTier', () => {
    for (const input of stringFuzz) {
        test(`classifyModelTier(${JSON.stringify(input).slice(0, 40)}) does not throw`, () => {
            expect(() => classifyModelTier(input)).not.toThrow();
        });
    }
});

describe('string fuzz: extractConversationId', () => {
    for (const input of stringFuzz) {
        test(`extractConversationId(${JSON.stringify(input).slice(0, 40)}) does not throw`, () => {
            expect(() => extractConversationId(input)).not.toThrow();
        });
    }
});

describe('string fuzz: extractOrganizationId', () => {
    for (const input of stringFuzz) {
        test(`extractOrganizationId(${JSON.stringify(input).slice(0, 40)}) does not throw`, () => {
            expect(() => extractOrganizationId(input)).not.toThrow();
        });
    }
});

describe('string fuzz: extractTopicHint', () => {
    for (const input of stringFuzz) {
        test(`extractTopicHint(${JSON.stringify(input).slice(0, 40)}) does not throw`, () => {
            expect(() => extractTopicHint(input)).not.toThrow();
        });
    }

    doesNotHang(() => extractTopicHint('a'.repeat(1_000_000)), 'extractTopicHint with 1M chars');
});

describe('string fuzz: isValidBridgeSchema', () => {
    for (const input of stringFuzz) {
        test(`isValidBridgeSchema(${JSON.stringify(input).slice(0, 40)}) does not throw`, () => {
            expect(() => isValidBridgeSchema(input)).not.toThrow();
        });
    }
});

describe('string fuzz: deduplicateHints', () => {
    test('handles array of fuzz strings', () => {
        expect(() => deduplicateHints(stringFuzz)).not.toThrow();
    });

    test('1000 identical strings deduplicate to 1', () => {
        const hints = Array(1000).fill('same hint over and over');
        expect(deduplicateHints(hints)).toHaveLength(1);
    });
});

// ── Number fuzzing ─────────────────────────────────────────────────────────

describe('number fuzz: formatTokens', () => {
    for (const input of numFuzz) {
        test(`formatTokens(${input}) does not throw`, () => {
            expect(() => formatTokens(input)).not.toThrow();
        });
    }
});

describe('number fuzz: formatCost', () => {
    for (const input of numFuzz) {
        test(`formatCost(${input}) does not throw`, () => {
            expect(() => formatCost(input)).not.toThrow();
        });
    }
});

describe('number fuzz: classifyZone', () => {
    for (const input of numFuzz) {
        test(`classifyZone(${input}) does not throw`, () => {
            expect(() => classifyZone(input)).not.toThrow();
        });
    }
});

describe('number fuzz: calculateCost', () => {
    for (const input of numFuzz) {
        test(`calculateCost(${input}, 0, 'claude-sonnet-4-6') does not throw`, () => {
            expect(() => calculateCost(input, 0, 'claude-sonnet-4-6')).not.toThrow();
        });
        test(`calculateCost(0, ${input}, 'claude-sonnet-4-6') does not throw`, () => {
            expect(() => calculateCost(0, input, 'claude-sonnet-4-6')).not.toThrow();
        });
    }
});

describe('number fuzz: computeHealthScore', () => {
    for (const pct of numFuzz) {
        test(`contextPct=${pct} does not throw`, () => {
            expect(() => computeHealthScore({ contextPct: pct, turnCount: 5, growthRate: null, model: 'claude-sonnet-4-6', isDetailHeavy: false })).not.toThrow();
        });
    }
    for (const turns of numFuzz) {
        test(`turnCount=${turns} does not throw`, () => {
            expect(() => computeHealthScore({ contextPct: 50, turnCount: turns, growthRate: null, model: 'claude-sonnet-4-6', isDetailHeavy: false })).not.toThrow();
        });
    }
    for (const rate of numFuzz) {
        test(`growthRate=${rate} does not throw`, () => {
            expect(() => computeHealthScore({ contextPct: 50, turnCount: 5, growthRate: rate, model: 'claude-sonnet-4-6', isDetailHeavy: false })).not.toThrow();
        });
    }
});

describe('number fuzz: computeGrowthRate', () => {
    test('array of fuzz numbers does not throw', () => {
        expect(() => computeGrowthRate(numFuzz)).not.toThrow();
    });
});

describe('number fuzz: formatRelativeTime', () => {
    for (const input of numFuzz) {
        test(`formatRelativeTime(${input}) does not throw`, () => {
            expect(() => formatRelativeTime(input)).not.toThrow();
        });
    }
});

describe('number fuzz: todayDateString', () => {
    for (const input of numFuzz) {
        test(`todayDateString(${input}) does not throw`, () => {
            // NaN and Infinity produce "NaN-NaN-NaN" which is fine, just should not throw
            expect(() => todayDateString(input)).not.toThrow();
        });
    }
});

// ── Type confusion ─────────────────────────────────────────────────────────

describe('type confusion: isValidBridgeSchema', () => {
    for (const input of typeFuzz) {
        test(`isValidBridgeSchema(${String(input)}) returns false`, () => {
            expect(isValidBridgeSchema(input)).toBe(false);
        });
    }
});

describe('type confusion: pickTopSignal', () => {
    test('empty array returns null', () => {
        expect(pickTopSignal([])).toBeNull();
    });
});

// ── Extreme numeric edge cases in calculateCost ────────────────────────────

describe('calculateCost extreme values', () => {
    test('MAX_SAFE_INTEGER tokens does not produce Infinity', () => {
        const cost = calculateCost(Number.MAX_SAFE_INTEGER, 0, 'claude-haiku-4-5');
        // $1/M * 9007199254740991 tokens = $9,007,199,254.74 (should be finite)
        expect(cost).not.toBeNull();
        expect(Number.isFinite(cost!)).toBe(true);
    });

    test('MAX_VALUE tokens produces finite result (small per-token cost)', () => {
        const cost = calculateCost(Number.MAX_VALUE, 0, 'claude-haiku-4-5');
        // MAX_VALUE * 1e-6 is still finite (MAX_VALUE ~ 1.8e308, result ~ 1.8e302)
        expect(cost).not.toBeNull();
        expect(Number.isFinite(cost!)).toBe(true);
    });
});

// ── Global state pollution check ───────────────────────────────────────────

describe('no global state pollution', () => {
    test('Object.prototype is clean after all fuzz tests', () => {
        expect(({} as any).isAdmin).toBeUndefined();
        expect(({} as any).polluted).toBeUndefined();
    });
});
