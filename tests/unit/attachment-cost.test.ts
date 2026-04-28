import { describe, it, expect } from 'vitest';
import {
    computeImageTokens,
    computePdfTokenRange,
    computeAttachmentCost,
    PDF_TOKENS_PER_PAGE_LOW,
    PDF_TOKENS_PER_PAGE_HIGH,
    type AttachmentDescriptor,
} from '../../lib/attachment-cost';

// ── Drift detection: Anthropic's published image table ──────────────────────
//
// Source: https://platform.claude.com/docs/en/build-with-claude/vision
// Pinned in: docs/attachment-cost-spec.md
//
// If any of these assertions fail, Anthropic likely changed the formula or
// the per-model caps. Refetch the docs, update the spec, update the constants
// in lib/attachment-cost.ts, and adjust these expectations together.

describe('Anthropic image table - Sonnet 4.6 (drift detection)', () => {
    const MODEL = 'claude-sonnet-4-6';
    it.each([
        // [width, height, expected tokens, Anthropic's "approximately" value]
        [200, 200, 53],     // doc says ~54; w*h/750 = 53.33 -> 53 (rounded)
        [1000, 1000, 1333], // doc says ~1334; w*h/750 = 1333.33 -> 1333
        [1092, 1092, 1568], // doc says ~1568; raw = 1590, capped to 1568
        [1920, 1080, 1568], // doc says ~1568, downscaled
        [2000, 1500, 1568], // doc says ~1568, downscaled
    ])('%dx%d -> %d tokens', (w, h, expected) => {
        expect(computeImageTokens(w, h, MODEL)).toBe(expected);
    });
});

describe('Anthropic image table - Opus 4.7 (drift detection)', () => {
    const MODEL = 'claude-opus-4-7';
    it.each([
        [200, 200, 53],     // doc says ~54
        [1000, 1000, 1333], // doc says ~1334
        [1092, 1092, 1590], // doc says ~1590; no resize since 1092 < 2576, raw = 1590
        [1920, 1080, 2765], // doc says ~2765; 1920*1080/750 = 2764.8 -> 2765
        [2000, 1500, 4000], // doc says ~4000; 2000*1500/750 = 4000
    ])('%dx%d -> %d tokens', (w, h, expected) => {
        expect(computeImageTokens(w, h, MODEL)).toBe(expected);
    });
});

// ── Image edge cases ────────────────────────────────────────────────────────

describe('computeImageTokens edge cases', () => {
    it('zero dimensions return 0', () => {
        expect(computeImageTokens(0, 0, 'claude-sonnet-4-6')).toBe(0);
        expect(computeImageTokens(1000, 0, 'claude-sonnet-4-6')).toBe(0);
        expect(computeImageTokens(0, 1000, 'claude-sonnet-4-6')).toBe(0);
    });

    it('negative dimensions return 0', () => {
        expect(computeImageTokens(-5, 1000, 'claude-sonnet-4-6')).toBe(0);
    });

    it('unknown model returns null', () => {
        expect(computeImageTokens(500, 500, 'gpt-4-turbo')).toBeNull();
        expect(computeImageTokens(500, 500, '')).toBeNull();
    });

    it('caps at 1568 tokens for very large images on Sonnet', () => {
        expect(computeImageTokens(8000, 8000, 'claude-sonnet-4-6')).toBe(1568);
    });

    it('caps at 4784 tokens for very large images on Opus 4.7', () => {
        expect(computeImageTokens(8000, 8000, 'claude-opus-4-7')).toBe(4784);
    });

    it('handles wide aspect ratio with long-edge resize on Sonnet', () => {
        // 3000x100 on Sonnet: long edge 3000 > 1568, scale = 1568/3000 = 0.5227.
        // Resized to 1568x52 (rounded). Tokens = 1568*52/750 = 108.7 -> 109.
        const t = computeImageTokens(3000, 100, 'claude-sonnet-4-6');
        expect(t).toBe(109);
    });

    it('handles tall aspect ratio with long-edge resize on Opus 4.7', () => {
        // 100x3000 on Opus 4.7: long edge 3000 > 2576, scale = 2576/3000 = 0.8587.
        // Resized to 86x2576. Tokens = 86*2576/750 = 295.4 -> 295.
        const t = computeImageTokens(100, 3000, 'claude-opus-4-7');
        expect(t).toBe(295);
    });

    it('Haiku 4.5 (200K context) uses default 1568 caps', () => {
        expect(computeImageTokens(2000, 1500, 'claude-haiku-4-5')).toBe(1568);
    });

    it('Sonnet long-form model ID also resolves to default caps', () => {
        expect(computeImageTokens(1000, 1000, 'claude-sonnet-4-6-20250514')).toBe(1333);
    });

    it('Opus 4.6 (1M context, no high-res) uses default caps', () => {
        // Opus 4.6 has 1M context but does NOT have high-res image support;
        // only Opus 4.7 does. This is the trap a multiplier-based model would
        // fall into; the per-model caps table catches it correctly.
        expect(computeImageTokens(2000, 1500, 'claude-opus-4-6')).toBe(1568);
    });
});

// ── PDF token range ─────────────────────────────────────────────────────────

describe('computePdfTokenRange', () => {
    it.each([
        [1, 1500, 3000],
        [10, 15000, 30000],
        [100, 150000, 300000],
        [600, 900000, 1800000],
    ])('%d pages -> [%d, %d] tokens', (pages, low, high) => {
        expect(computePdfTokenRange(pages)).toEqual({ low, high });
    });

    it('zero or negative pages returns zero range', () => {
        expect(computePdfTokenRange(0)).toEqual({ low: 0, high: 0 });
        expect(computePdfTokenRange(-1)).toEqual({ low: 0, high: 0 });
    });

    it('Anthropic published constants are stable', () => {
        // Drift sentinel: if Anthropic publishes a new range, these break first
        // and force a docs review. Source: build-with-claude/pdf-support.
        expect(PDF_TOKENS_PER_PAGE_LOW).toBe(1500);
        expect(PDF_TOKENS_PER_PAGE_HIGH).toBe(3000);
    });
});

// ── computeAttachmentCost: combined behavior ─────────────────────────────────

describe('computeAttachmentCost', () => {
    const img = (w: number, h: number, name = 'img.png', fileSize = 50_000): AttachmentDescriptor =>
        ({ kind: 'image', width: w, height: h, sourceLabel: name, fileSize });
    const pdf = (pages: number, name = 'doc.pdf', fileSize = 200_000): AttachmentDescriptor =>
        ({ kind: 'pdf', pageCount: pages, sourceLabel: name, fileSize });

    it('empty list returns zero totals and empty breakdown', () => {
        const r = computeAttachmentCost([], 'claude-sonnet-4-6');
        expect(r.totalTokensLow).toBe(0);
        expect(r.totalTokensHigh).toBe(0);
        expect(r.breakdown).toHaveLength(0);
        expect(r.warnings).toHaveLength(0);
        expect(r.hasUnknownImage).toBe(false);
        expect(r.hasPdf).toBe(false);
    });

    it('image-only sums correctly on Sonnet', () => {
        const r = computeAttachmentCost([img(1000, 1000)], 'claude-sonnet-4-6');
        expect(r.totalTokensLow).toBe(1333);
        expect(r.totalTokensHigh).toBe(1333);
        expect(r.hasPdf).toBe(false);
        expect(r.breakdown[0].kind).toBe('image');
        expect(r.breakdown[0].tokensHigh).toBeUndefined();
    });

    it('PDF-only returns proper low/high range', () => {
        const r = computeAttachmentCost([pdf(8)], 'claude-sonnet-4-6');
        expect(r.totalTokensLow).toBe(8 * 1500);
        expect(r.totalTokensHigh).toBe(8 * 3000);
        expect(r.hasPdf).toBe(true);
        expect(r.breakdown[0].kind).toBe('pdf');
        expect(r.breakdown[0].tokens).toBe(8 * 1500);
        expect(r.breakdown[0].tokensHigh).toBe(8 * 3000);
        expect(r.breakdown[0].label).toContain('8 pages');
    });

    it('singular page label for 1-page PDF', () => {
        const r = computeAttachmentCost([pdf(1)], 'claude-sonnet-4-6');
        expect(r.breakdown[0].label).toContain('1 page');
        expect(r.breakdown[0].label).not.toContain('pages');
    });

    it('mixed image and PDF sum each component independently', () => {
        const r = computeAttachmentCost([img(1000, 1000), pdf(5)], 'claude-sonnet-4-6');
        expect(r.totalTokensLow).toBe(1333 + 5 * 1500);
        expect(r.totalTokensHigh).toBe(1333 + 5 * 3000);
        expect(r.breakdown).toHaveLength(2);
    });

    it('image on unknown model marks unknown without breaking the total', () => {
        const r = computeAttachmentCost(
            [img(500, 500, 'a.png'), pdf(2, 'b.pdf')],
            'gpt-4-turbo',
        );
        expect(r.hasUnknownImage).toBe(true);
        expect(r.totalTokensLow).toBe(2 * 1500);
        expect(r.totalTokensHigh).toBe(2 * 3000);
        expect(r.breakdown[0].unknown).toBe(true);
        expect(r.breakdown[0].tokens).toBe(0);
    });

    it('PDF with null page count surfaces an unknown breakdown', () => {
        const r = computeAttachmentCost(
            [{ kind: 'pdf', pageCount: null, sourceLabel: 'encrypted.pdf', fileSize: 200_000 }],
            'claude-sonnet-4-6',
        );
        expect(r.hasPdf).toBe(true);
        expect(r.totalTokensLow).toBe(0);
        expect(r.totalTokensHigh).toBe(0);
        expect(r.breakdown).toHaveLength(1);
        expect(r.breakdown[0].unknown).toBe(true);
        expect(r.breakdown[0].label).toContain('unavailable');
    });

    it('null-page PDF mixed with parseable PDF only counts the parseable one', () => {
        const r = computeAttachmentCost([
            { kind: 'pdf', pageCount: null, sourceLabel: 'a.pdf', fileSize: 200_000 },
            { kind: 'pdf', pageCount: 3, sourceLabel: 'b.pdf', fileSize: 200_000 },
        ], 'claude-sonnet-4-6');
        expect(r.totalTokensLow).toBe(3 * 1500);
        expect(r.totalTokensHigh).toBe(3 * 3000);
        expect(r.breakdown).toHaveLength(2);
    });

    it('warns when PDF pages exceed 100-page cap on a 200K model (Haiku)', () => {
        const r = computeAttachmentCost([pdf(150)], 'claude-haiku-4-5');
        expect(r.warnings.length).toBeGreaterThan(0);
        expect(r.warnings[0]).toContain('150');
        expect(r.warnings[0]).toContain('100');
    });

    it('does not warn at exactly the 100-page cap on a 200K model', () => {
        const r = computeAttachmentCost([pdf(100)], 'claude-haiku-4-5');
        expect(r.warnings).toHaveLength(0);
    });

    it('warns above 600 pages on a 1M-context model (Sonnet)', () => {
        const r = computeAttachmentCost([pdf(700)], 'claude-sonnet-4-6');
        expect(r.warnings.length).toBeGreaterThan(0);
        expect(r.warnings[0]).toContain('700');
        expect(r.warnings[0]).toContain('600');
    });

    it('aggregates page count across multiple PDFs for cap warning', () => {
        const r = computeAttachmentCost([pdf(60), pdf(60)], 'claude-haiku-4-5');
        expect(r.warnings.length).toBeGreaterThan(0);
        expect(r.warnings[0]).toContain('120');
    });

    it('breakdown labels include exact dimensions for images', () => {
        const r = computeAttachmentCost([img(1568, 1568)], 'claude-sonnet-4-6');
        expect(r.breakdown[0].label).toContain('1568x1568');
    });

    // ── Aggregate request-size warning (Anthropic 32 MB hard cap) ──────────

    it('warns when aggregate file size approaches the 32 MB request cap', () => {
        // 31 MB total: above the 30 MB warn threshold, below the 32 MB hard cap.
        const r = computeAttachmentCost([
            { kind: 'pdf', pageCount: 50, sourceLabel: 'big.pdf', fileSize: 31 * 1024 * 1024 },
        ], 'claude-sonnet-4-6');
        expect(r.warnings.length).toBeGreaterThan(0);
        const w = r.warnings.find(s => s.includes('32 MB'));
        expect(w).toBeDefined();
        expect(w).toContain('approaching');
    });

    it('warns more strongly when aggregate file size exceeds the 32 MB hard cap', () => {
        const r = computeAttachmentCost([
            { kind: 'pdf', pageCount: 50, sourceLabel: 'huge.pdf', fileSize: 35 * 1024 * 1024 },
        ], 'claude-sonnet-4-6');
        const w = r.warnings.find(s => s.includes('32 MB'));
        expect(w).toBeDefined();
        expect(w).toContain('exceeds');
    });

    it('aggregates file size across multiple attachments', () => {
        // Two 16 MB images add to 32 MB which is above the warn threshold.
        const r = computeAttachmentCost([
            { kind: 'image', width: 4000, height: 4000, sourceLabel: 'a.png', fileSize: 16 * 1024 * 1024 },
            { kind: 'image', width: 4000, height: 4000, sourceLabel: 'b.png', fileSize: 16 * 1024 * 1024 },
        ], 'claude-sonnet-4-6');
        const w = r.warnings.find(s => s.includes('32 MB'));
        expect(w).toBeDefined();
        expect(w).toContain('32.0');
    });

    it('does not warn at small total file sizes', () => {
        const r = computeAttachmentCost([
            img(500, 500, 'a.png', 100_000),
            pdf(5, 'b.pdf', 200_000),
        ], 'claude-sonnet-4-6');
        const w = r.warnings.find(s => s.includes('32 MB'));
        expect(w).toBeUndefined();
    });
});
