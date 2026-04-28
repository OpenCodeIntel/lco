// lib/attachment-cost.ts
// Attachment Cost Agent: predicts the input token cost of image and PDF
// attachments before send. Pure functions only, no DOM refs, no chrome APIs.
//
// All math is sourced from Anthropic's published vision and PDF docs and
// pinned in docs/attachment-cost-spec.md. The drift tests in
// tests/unit/attachment-cost.test.ts assert every Anthropic example value
// from that spec verbatim; if any test fails, refetch the docs and update
// this file plus the spec in lockstep.
//
// ── Role in the multi-agent architecture ─────────────────────────────────────
//
// | Agent                | Module               | Input                 | Output                  |
// |----------------------|----------------------|-----------------------|-------------------------|
// | Pre-Submit Agent     | pre-submit.ts        | PreSubmitInput        | PreSubmitEstimate       |
// | **Attachment Cost**  | **attachment-cost.ts**| **AttachmentDescriptor[]** | **AttachmentCostResult** |
//
// The orchestrator collects attachments from the compose box (see
// claude-ai.content.ts), runs computeAttachmentCost, then feeds the totals
// and breakdown into computePreSubmitEstimate. Image cost is deterministic
// from pixel dimensions; PDF cost is reported as a low-high range because
// Anthropic itself publishes the per-page cost as a 1500-3000 range.

import { isKnownModel, getContextWindowSize } from './pricing';

// ── Public types ─────────────────────────────────────────────────────────────

export type AttachmentDescriptor =
    | { kind: 'image'; width: number; height: number; sourceLabel: string; fileSize: number }
    /**
     * pageCount is null when local parsing failed (encrypted, fully-compressed
     * page tree, malformed). The agent emits an unknown-cost breakdown row in
     * that case so the user still sees the file is tracked.
     */
    | { kind: 'pdf'; pageCount: number | null; sourceLabel: string; fileSize: number };

/** One row in the per-attachment overlay breakdown. */
export interface AttachmentBreakdownItem {
    kind: 'image' | 'pdf';
    /** Token contribution. For images: exact. For PDFs: low end of the range. */
    tokens: number;
    /** Defined only for PDFs (high end of range). Undefined when tokens is exact. */
    tokensHigh?: number;
    /** Human-readable line for the overlay (e.g. "image 1568x1568", "PDF 8 pages"). */
    label: string;
    /** True when the image's cost cannot be predicted on this model; UI shows "?". */
    unknown?: boolean;
}

export interface AttachmentCostResult {
    /** Lower bound of total attachment tokens. Images contribute exact; PDFs contribute low. */
    totalTokensLow: number;
    /** Upper bound. Images contribute exact; PDFs contribute high. */
    totalTokensHigh: number;
    breakdown: AttachmentBreakdownItem[];
    /** Hard warnings: page caps exceeded, etc. Rendered prominently in the overlay. */
    warnings: string[];
    /** True when at least one image is on a model with no published cost; surfaces "?". */
    hasUnknownImage: boolean;
    /** True when at least one PDF is included; surfaces the per-page-image disclosure. */
    hasPdf: boolean;
}

// ── Image constants (verbatim from Anthropic's vision docs) ──────────────────

interface ImageCaps { maxLongPx: number; maxTokens: number; }

/**
 * Opus 4.7 supports high-resolution images: longer edge up to 2576 px, max
 * 4784 tokens per image. Source: vision docs, "High-resolution image support".
 */
const OPUS_4_7_CAPS: ImageCaps = { maxLongPx: 2576, maxTokens: 4784 };

/**
 * Default caps for every other Claude vision model: longer edge up to 1568 px,
 * max 1568 tokens per image. Source: vision docs, "Evaluate image size".
 */
const DEFAULT_CAPS: ImageCaps = { maxLongPx: 1568, maxTokens: 1568 };

/** Tokens-per-pixel divisor: tokens = round(w * h / 750). */
const TOKENS_PER_PIXEL_DIVISOR = 750;

function imageCaps(model: string): ImageCaps {
    if (model.startsWith('claude-opus-4-7')) return OPUS_4_7_CAPS;
    return DEFAULT_CAPS;
}

// ── PDF constants (verbatim from Anthropic's PDF docs) ───────────────────────

/** Lower bound of Anthropic's published per-page text-token range. */
export const PDF_TOKENS_PER_PAGE_LOW = 1500;

/** Upper bound of Anthropic's published per-page text-token range. */
export const PDF_TOKENS_PER_PAGE_HIGH = 3000;

/** PDF page caps per Anthropic's PDF docs ("Maximum pages per request"). */
const PDF_PAGE_LIMIT_200K = 100;
const PDF_PAGE_LIMIT_1M = 600;

/**
 * Total request size cap from Anthropic's "Maximum request size: 32 MB".
 * We warn at REQUEST_SIZE_WARN_BYTES (30 MB) so the user has 2 MB of margin
 * for the prompt body and JSON overhead before the request is rejected.
 */
const REQUEST_SIZE_HARD_BYTES = 32 * 1024 * 1024;
const REQUEST_SIZE_WARN_BYTES = 30 * 1024 * 1024;

/**
 * 200K-context models cap at 100 pages, larger-context models at 600. We read
 * the actual window size from the pricing table instead of hard-coding model
 * prefixes so a new 1M model lands without a code edit. The 500_000 threshold
 * sits comfortably between the two known tiers (200K and 1M) and avoids any
 * accidental match if Anthropic ever ships a hypothetical 256K or 384K model.
 * Unknown models fall back to 200K via getContextWindowSize, getting the
 * conservative 100-page cap.
 */
function pdfPageLimit(model: string): number {
    return getContextWindowSize(model) >= 500_000
        ? PDF_PAGE_LIMIT_1M
        : PDF_PAGE_LIMIT_200K;
}

// ── Public formulas ──────────────────────────────────────────────────────────

/**
 * Predicted input tokens for an image on the given model. Mirrors Anthropic's
 * algorithm exactly: resize the long edge to the per-model cap (preserving
 * aspect ratio), apply width * height / 750, clamp to maxTokens.
 *
 * Returns null when the model is not in the pricing table; the caller renders
 * "?" and skips the image's contribution to the total. Returns 0 for
 * non-positive dimensions.
 */
export function computeImageTokens(width: number, height: number, model: string): number | null {
    if (width <= 0 || height <= 0) return 0;
    if (!isKnownModel(model)) return null;

    const caps = imageCaps(model);
    const longEdge = Math.max(width, height);

    let w = width;
    let h = height;
    if (longEdge > caps.maxLongPx) {
        const scale = caps.maxLongPx / longEdge;
        w = Math.round(width * scale);
        h = Math.round(height * scale);
    }

    const raw = Math.round((w * h) / TOKENS_PER_PIXEL_DIVISOR);
    return Math.min(raw, caps.maxTokens);
}

/**
 * Predicted input tokens for a PDF, returned as Anthropic's published
 * low-high range. Not collapsed to a midpoint: Anthropic itself publishes a
 * range, not a point, and a single number would imply false precision.
 */
export function computePdfTokenRange(pageCount: number): { low: number; high: number } {
    if (pageCount <= 0) return { low: 0, high: 0 };
    return {
        low: pageCount * PDF_TOKENS_PER_PAGE_LOW,
        high: pageCount * PDF_TOKENS_PER_PAGE_HIGH,
    };
}

/**
 * Combined cost for a list of attachments on a given model. Sums token
 * contributions, builds per-attachment breakdown rows, emits hard warnings
 * when page caps are exceeded.
 */
export function computeAttachmentCost(
    attachments: readonly AttachmentDescriptor[],
    model: string,
): AttachmentCostResult {
    let totalLow = 0;
    let totalHigh = 0;
    const breakdown: AttachmentBreakdownItem[] = [];
    const warnings: string[] = [];
    let hasUnknownImage = false;
    let hasPdf = false;
    let pdfPageTotal = 0;

    for (const att of attachments) {
        if (att.kind === 'image') {
            const tokens = computeImageTokens(att.width, att.height, model);
            const dims = `${att.width}x${att.height}`;
            if (tokens === null) {
                hasUnknownImage = true;
                breakdown.push({
                    kind: 'image',
                    tokens: 0,
                    label: `image ${dims}`,
                    unknown: true,
                });
            } else {
                totalLow += tokens;
                totalHigh += tokens;
                breakdown.push({ kind: 'image', tokens, label: `image ${dims}` });
            }
        } else {
            hasPdf = true;
            if (att.pageCount === null) {
                // Page-count parsing failed; still surface the attachment so the
                // user sees it is tracked. Contributes 0 tokens to the totals.
                breakdown.push({
                    kind: 'pdf',
                    tokens: 0,
                    label: 'PDF (page count unavailable)',
                    unknown: true,
                });
                continue;
            }
            pdfPageTotal += att.pageCount;
            const range = computePdfTokenRange(att.pageCount);
            totalLow += range.low;
            totalHigh += range.high;
            const pageLabel = att.pageCount === 1 ? '1 page' : `${att.pageCount} pages`;
            breakdown.push({
                kind: 'pdf',
                tokens: range.low,
                tokensHigh: range.high,
                label: `PDF ${pageLabel}`,
            });
        }
    }

    if (pdfPageTotal > 0) {
        const cap = pdfPageLimit(model);
        if (pdfPageTotal > cap) {
            warnings.push(`${pdfPageTotal} PDF pages exceeds the ${cap}-page limit on this model. Split into sections.`);
        }
    }

    // Aggregate file-size warning. Anthropic's request cap is 32 MB; we warn
    // at 30 MB so users have margin for the rest of the request body.
    let totalBytes = 0;
    for (const att of attachments) totalBytes += att.fileSize;
    if (totalBytes > REQUEST_SIZE_WARN_BYTES) {
        const mb = (totalBytes / (1024 * 1024)).toFixed(1);
        const status = totalBytes > REQUEST_SIZE_HARD_BYTES ? 'exceeds' : 'is approaching';
        warnings.push(`Attachments total ${mb} MB; ${status} Anthropic's 32 MB request limit. Send fewer or smaller files.`);
    }

    return {
        totalTokensLow: totalLow,
        totalTokensHigh: totalHigh,
        breakdown,
        warnings,
        hasUnknownImage,
        hasPdf,
    };
}
