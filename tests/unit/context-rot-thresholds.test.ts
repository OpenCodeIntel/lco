// tests/unit/context-rot-thresholds.test.ts
//
// Tests for lib/context-rot-thresholds.ts. Three concerns:
//   1. Lookup correctness: every model resolves to its intended profile,
//      including the longest-prefix-match guarantee.
//   2. Threshold math: detail-heavy adjustment, floor behavior, zone
//      classification at and around boundaries.
//   3. Provenance: any profile that quotes an MRCR figure must carry a
//      sourceUrl AND a sourceQuote AND that quote must mention the figure.
//      This is the drift assertion: if someone changes a number without
//      updating the citation, the test fails loudly.

import { describe, it, expect } from 'vitest';
import {
    ABSOLUTE_CRITICAL_FLOOR,
    DETAIL_HEAVY_ADJUSTMENT,
    FALLBACK_PROFILE,
    MIN_THRESHOLD_FLOOR,
    ROT_PROFILES,
    applyDetailHeavyAdjustment,
    getEffectiveThresholds,
    getRotCoaching,
    getRotProfile,
    getRotZone,
} from '../../lib/context-rot-thresholds';

// ── getRotProfile: lookup ─────────────────────────────────────────────────

describe('getRotProfile: model lookup', () => {
    it('resolves Opus 4.7 by exact prefix', () => {
        const p = getRotProfile('claude-opus-4-7');
        expect(p.label).toBe('Opus 4.7');
        expect(p.contextWindow).toBe(1_000_000);
        expect(p.hasServerSideCompaction).toBe(true);
    });

    it('resolves Opus 4.6 with full Anthropic suffix', () => {
        const p = getRotProfile('claude-opus-4-6-20250514');
        expect(p.label).toBe('Opus 4.6');
        expect(p.mrcrAt1MPct).toBe(76);
    });

    it('resolves Sonnet 4.6 separately from Sonnet 4.5', () => {
        const sonnet46 = getRotProfile('claude-sonnet-4-6');
        const sonnet45 = getRotProfile('claude-sonnet-4-5');
        expect(sonnet46.contextWindow).toBe(1_000_000);
        expect(sonnet45.contextWindow).toBe(200_000);
        expect(sonnet46.warnAtPct).toBeGreaterThan(sonnet45.warnAtPct);
    });

    it('resolves Haiku 4.5 to the 200k profile', () => {
        const p = getRotProfile('claude-haiku-4-5');
        expect(p.contextWindow).toBe(200_000);
        expect(p.hasServerSideCompaction).toBe(false);
    });

    it('uses the longest matching prefix when multiple could match', () => {
        // Both 'claude-opus-4-6' and (hypothetically) 'claude-opus-4' would
        // match 'claude-opus-4-6-20250514'. Longest wins.
        const p = getRotProfile('claude-opus-4-6-20250514');
        expect(p.modelPrefix).toBe('claude-opus-4-6');
    });

    it('does not collide on a hypothetical "claude-sonnet-4-50"', () => {
        // Without the digit-boundary check, the naive startsWith match
        // would classify "claude-sonnet-4-50" as the 4-5 profile (200k
        // window), which would silently misroute a future Anthropic
        // model into Sonnet 4.5's coaching. We expect the boundary check
        // to reject that match and fall through to FALLBACK_PROFILE.
        const p = getRotProfile('claude-sonnet-4-50');
        expect(p.modelPrefix).not.toBe('claude-sonnet-4-5');
        expect(p).toEqual(FALLBACK_PROFILE);
    });

    it('still accepts the date-suffixed form like claude-sonnet-4-5-20250929', () => {
        // The boundary check should let through non-digit characters
        // (typically '-' before the date suffix). Verify the canonical
        // versioned model name still resolves to its profile.
        const p = getRotProfile('claude-sonnet-4-5-20250929');
        expect(p.modelPrefix).toBe('claude-sonnet-4-5');
    });

    it('is case-insensitive on the input', () => {
        const lower = getRotProfile('claude-sonnet-4-6');
        const upper = getRotProfile('CLAUDE-SONNET-4-6');
        expect(upper).toEqual(lower);
    });

    it('falls back for unknown models', () => {
        expect(getRotProfile('llama-3-1')).toEqual(FALLBACK_PROFILE);
        expect(getRotProfile('gpt-4-turbo')).toEqual(FALLBACK_PROFILE);
    });

    it('falls back for empty model string', () => {
        expect(getRotProfile('')).toEqual(FALLBACK_PROFILE);
    });
});

// ── getEffectiveThresholds: detail-heavy adjustment ──────────────────────

describe('getEffectiveThresholds: detail-heavy adjustment', () => {
    it('returns the profile values when not detail-heavy', () => {
        const t = getEffectiveThresholds('claude-opus-4-6', false);
        expect(t.warnAtPct).toBe(65);
        expect(t.criticalAtPct).toBe(85);
    });

    it('subtracts DETAIL_HEAVY_ADJUSTMENT from both thresholds when detail-heavy', () => {
        const t = getEffectiveThresholds('claude-opus-4-6', true);
        expect(t.warnAtPct).toBe(65 - DETAIL_HEAVY_ADJUSTMENT);
        expect(t.criticalAtPct).toBe(85 - DETAIL_HEAVY_ADJUSTMENT);
    });

    it('adjusts Sonnet 4.5 thresholds correctly under detail-heavy', () => {
        const t = getEffectiveThresholds('claude-sonnet-4-5', true);
        expect(t.warnAtPct).toBe(35);  // 50 - 15
        expect(t.criticalAtPct).toBe(60); // 75 - 15
    });

    it('floors at MIN_THRESHOLD_FLOOR for known-low Haiku profile', () => {
        // Sanity: every shipping profile after detail-heavy adjustment
        // stays at or above the floor. Catches future tuning that drops
        // a profile below the floor without bumping the floor itself.
        const t = getEffectiveThresholds('claude-haiku-4-5', true);
        expect(t.warnAtPct).toBeGreaterThanOrEqual(MIN_THRESHOLD_FLOOR);
        expect(t.criticalAtPct).toBeGreaterThanOrEqual(MIN_THRESHOLD_FLOOR);
    });
});

// ── applyDetailHeavyAdjustment: direct exercise of the floor branch ─────
//
// No real profile is low enough today that warn - 15 < MIN_THRESHOLD_FLOOR,
// so the floor branch in the production code is dead by inspection. The
// helper is exposed so we can verify the floor actually fires when the
// math demands it. If anyone ever lowers a profile's warn below 45,
// this test catches a silent change in coaching behavior.

describe('applyDetailHeavyAdjustment: floor branch', () => {
    it('returns the threshold unchanged when not detail-heavy', () => {
        expect(applyDetailHeavyAdjustment(50, false)).toBe(50);
        expect(applyDetailHeavyAdjustment(MIN_THRESHOLD_FLOOR + 5, false)).toBe(MIN_THRESHOLD_FLOOR + 5);
    });

    it('subtracts DETAIL_HEAVY_ADJUSTMENT when detail-heavy and result is above floor', () => {
        expect(applyDetailHeavyAdjustment(65, true)).toBe(65 - DETAIL_HEAVY_ADJUSTMENT);
        expect(applyDetailHeavyAdjustment(50, true)).toBe(50 - DETAIL_HEAVY_ADJUSTMENT);
    });

    it('floors at MIN_THRESHOLD_FLOOR when adjustment would drop below it', () => {
        // 40 - 15 = 25, below the 30 floor: floor wins.
        expect(applyDetailHeavyAdjustment(40, true)).toBe(MIN_THRESHOLD_FLOOR);
        // 35 - 15 = 20, well below: still 30.
        expect(applyDetailHeavyAdjustment(35, true)).toBe(MIN_THRESHOLD_FLOOR);
    });

    it('returns exactly MIN_THRESHOLD_FLOOR at the boundary', () => {
        // 45 - 15 = 30, exactly at the floor.
        expect(applyDetailHeavyAdjustment(45, true)).toBe(MIN_THRESHOLD_FLOOR);
    });

    it('does not raise a threshold that is already below the floor', () => {
        // The function only floors AFTER the subtraction. A caller that
        // passes a value below the floor with isDetailHeavy=false should
        // get it back unchanged; the floor is a downward guard, not an
        // unconditional clamp.
        expect(applyDetailHeavyAdjustment(20, false)).toBe(20);
    });
});

// ── getRotZone: zone classification ──────────────────────────────────────

describe('getRotZone: zone classification', () => {
    it('returns healthy below the warn threshold', () => {
        expect(getRotZone('claude-sonnet-4-6', 30, false)).toBe('healthy');
        expect(getRotZone('claude-opus-4-6', 50, false)).toBe('healthy');
    });

    it('returns approaching at the warn threshold', () => {
        expect(getRotZone('claude-sonnet-4-6', 60, false)).toBe('approaching');
        expect(getRotZone('claude-opus-4-6', 65, false)).toBe('approaching');
    });

    it('returns approaching just below the critical threshold', () => {
        expect(getRotZone('claude-sonnet-4-6', 79, false)).toBe('approaching');
        expect(getRotZone('claude-opus-4-6', 84, false)).toBe('approaching');
    });

    it('returns in-rot at the critical threshold', () => {
        expect(getRotZone('claude-sonnet-4-6', 80, false)).toBe('in-rot');
        expect(getRotZone('claude-opus-4-6', 85, false)).toBe('in-rot');
    });

    it('detail-heavy shifts the zone earlier', () => {
        // Sonnet 4.6 at 50%: healthy when not detail-heavy (warn=60),
        // approaching when detail-heavy (warn=45).
        expect(getRotZone('claude-sonnet-4-6', 50, false)).toBe('healthy');
        expect(getRotZone('claude-sonnet-4-6', 50, true)).toBe('approaching');
    });

    it('detail-heavy can push from approaching to in-rot', () => {
        // Opus 4.6 at 75%: approaching when not detail-heavy (warn=65, crit=85),
        // in-rot when detail-heavy (warn=50, crit=70).
        expect(getRotZone('claude-opus-4-6', 75, false)).toBe('approaching');
        expect(getRotZone('claude-opus-4-6', 75, true)).toBe('in-rot');
    });

    it('respects the absolute critical floor regardless of model', () => {
        // Even Opus 4.7 (the most-permissive 1M profile) trips in-rot at 90%.
        expect(getRotZone('claude-opus-4-7', ABSOLUTE_CRITICAL_FLOOR, false)).toBe('in-rot');
        expect(getRotZone('claude-opus-4-7', 95, false)).toBe('in-rot');
    });

    it('classifies unknown models via the fallback profile', () => {
        // Fallback uses Sonnet 4.5 numbers (50/75).
        expect(getRotZone('unknown-model', 49, false)).toBe('healthy');
        expect(getRotZone('unknown-model', 50, false)).toBe('approaching');
        expect(getRotZone('unknown-model', 75, false)).toBe('in-rot');
    });
});

// ── getRotCoaching: copy ─────────────────────────────────────────────────

describe('getRotCoaching: copy generation', () => {
    it('returns "fresh and responsive" copy for very low context', () => {
        const msg = getRotCoaching('claude-sonnet-4-6', 5, false);
        expect(msg).toMatch(/fresh and responsive/i);
    });

    it('mentions the model label and window in the healthy zone above 30%', () => {
        const msg = getRotCoaching('claude-sonnet-4-6', 45, false);
        expect(msg).toContain('Sonnet 4.6');
        expect(msg).toContain('1M');
        expect(msg).toMatch(/45%/);
    });

    it('shows 200k window for Sonnet 4.5', () => {
        const msg = getRotCoaching('claude-sonnet-4-5', 35, false);
        expect(msg).toContain('Sonnet 4.5');
        expect(msg).toContain('200k');
    });

    it('cites the MRCR figure verbatim in approaching zone for Sonnet 4.5', () => {
        const msg = getRotCoaching('claude-sonnet-4-5', 55, false);
        expect(msg).toMatch(/Sonnet 4\.5/);
        expect(msg).toMatch(/18\.5%/);
        expect(msg).toMatch(/MRCR/);
    });

    it('cites the MRCR figure verbatim in approaching zone for Opus 4.6', () => {
        const msg = getRotCoaching('claude-opus-4-6', 70, false);
        expect(msg).toMatch(/Opus 4\.6/);
        expect(msg).toMatch(/76%/);
        expect(msg).toMatch(/MRCR/);
    });

    it('omits MRCR clause for models without a published score', () => {
        // Sonnet 4.6 has no MRCR on its profile; copy should not invent one.
        const msg = getRotCoaching('claude-sonnet-4-6', 65, false);
        expect(msg).not.toMatch(/MRCR/);
    });

    it('uses compaction-aware copy for 1M models in approaching zone', () => {
        const msg = getRotCoaching('claude-sonnet-4-6', 65, false);
        expect(msg).toMatch(/compaction/i);
    });

    it('uses harder copy for non-compaction models in approaching zone', () => {
        const msg = getRotCoaching('claude-sonnet-4-5', 55, false);
        expect(msg).toMatch(/start a new chat now/i);
        expect(msg).not.toMatch(/compaction/i);
    });

    it('mentions Projects in the in-rot zone for non-compaction models', () => {
        const msg = getRotCoaching('claude-sonnet-4-5', 80, false);
        expect(msg).toMatch(/Projects/);
        expect(msg).toMatch(/start a new chat/i);
    });

    it('uses a softer in-rot message for compaction-aware models', () => {
        const msg = getRotCoaching('claude-opus-4-7', 90, false);
        expect(msg).toMatch(/compaction/i);
        expect(msg).toMatch(/fine details/i);
    });

    it('never includes a `/compact` instruction in any copy', () => {
        // claude.ai web does not expose `/compact`. The slash command
        // belongs to Claude Code only. This guard prevents drift.
        for (const model of ['claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-haiku-4-5']) {
            for (const pct of [10, 50, 70, 85, 95]) {
                const msg = getRotCoaching(model, pct, false);
                expect(msg).not.toMatch(/\/compact/);
            }
        }
    });

    it('returns non-empty copy across the full range and all models', () => {
        for (const model of ['claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-haiku-4-5', 'unknown-model']) {
            for (const pct of [0, 25, 50, 65, 75, 85, 95]) {
                for (const detail of [true, false]) {
                    const msg = getRotCoaching(model, pct, detail);
                    expect(msg.length).toBeGreaterThan(0);
                }
            }
        }
    });
});

// ── Provenance / drift guard ─────────────────────────────────────────────

describe('drift guard: every cited fact has provenance', () => {
    it('every profile with mrcrAt1MPct also has sourceUrl and sourceQuote', () => {
        for (const profile of ROT_PROFILES) {
            if (profile.mrcrAt1MPct !== undefined) {
                expect(profile.sourceUrl, `${profile.label}: missing sourceUrl`).toBeTruthy();
                expect(profile.sourceQuote, `${profile.label}: missing sourceQuote`).toBeTruthy();
            }
        }
    });

    it('every quoted MRCR figure appears verbatim in its sourceQuote', () => {
        // Catches the case where someone changes the number but forgets
        // to update the quote (or vice versa). The pinned quote currently
        // contains both Opus 4.6's 76% and Sonnet 4.5's 18.5%.
        for (const profile of ROT_PROFILES) {
            if (profile.mrcrAt1MPct !== undefined && profile.sourceQuote) {
                expect(
                    profile.sourceQuote,
                    `${profile.label}: source quote does not mention ${profile.mrcrAt1MPct}%`,
                ).toContain(`${profile.mrcrAt1MPct}%`);
            }
        }
    });

    it('every sourceUrl looks like an Anthropic URL', () => {
        for (const profile of ROT_PROFILES) {
            if (profile.sourceUrl) {
                expect(profile.sourceUrl).toMatch(/anthropic\.com|claude\.com/);
            }
        }
    });
});

// ── Constants sanity ─────────────────────────────────────────────────────

describe('constants: sanity bounds', () => {
    it('every profile has warn < critical', () => {
        for (const profile of ROT_PROFILES) {
            expect(profile.warnAtPct).toBeLessThan(profile.criticalAtPct);
        }
    });

    it('every profile critical is below the absolute floor', () => {
        // Otherwise the per-model crit never fires before the absolute
        // safety net, making it dead code.
        for (const profile of ROT_PROFILES) {
            expect(profile.criticalAtPct).toBeLessThanOrEqual(ABSOLUTE_CRITICAL_FLOOR);
        }
    });

    it('every profile has a positive context window', () => {
        for (const profile of ROT_PROFILES) {
            expect(profile.contextWindow).toBeGreaterThan(0);
        }
    });

    it('DETAIL_HEAVY_ADJUSTMENT is positive and meaningful', () => {
        expect(DETAIL_HEAVY_ADJUSTMENT).toBeGreaterThan(0);
        expect(DETAIL_HEAVY_ADJUSTMENT).toBeLessThan(50);
    });
});
