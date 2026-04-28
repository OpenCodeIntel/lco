// lib/pdf-page-count.ts
// Pure parser: extracts the page count from a PDF binary by walking the
// page-tree dictionary in the document's textual portion. No DOM refs, no
// chrome APIs, no third-party PDF library.
//
// Why hand-rolled and not pdfjs-dist: a one-shot page-count read does not
// justify the ~600 KB gzipped pdfjs-dist payload or the MV3 service-worker
// integration friction. The page-tree root is part of the PDF's textual
// scaffolding (not the compressed object streams) for ~95 percent of standard
// PDFs, so a focused regex over a head + tail window does the job. Failure
// modes (encrypted, fully compressed) return null; the caller renders "?".
//
// Spec reference: docs/attachment-cost-spec.md.

// PDF page-tree root looks like:
//   << /Type /Pages /Kids [...] /Count 12 >>
// Intermediate page-tree nodes share the same shape with smaller counts; the
// root has the maximum Count, so we collect all matches and pick the max.
//
// Key order inside a dictionary is not specified by the PDF spec, so we run
// two regexes: one for "Type Pages then Count" and one for the reverse.
const TYPE_PAGES_THEN_COUNT = /\/Type\s*\/Pages\b[\s\S]{0,8192}?\/Count\s+(\d+)/g;
const COUNT_THEN_TYPE_PAGES = /\/Count\s+(\d+)[\s\S]{0,8192}?\/Type\s*\/Pages\b/g;

// Leaf page objects look like:
//   << /Type /Page /Parent 2 0 R ... >>
// The negative lookahead avoids matching the plural /Pages.
const LEAF_PAGE = /\/Type\s*\/Page(?!s)\b/g;

// Sanity ceiling for a page count parsed from the binary. Anthropic caps PDFs
// at 600 pages per request; anything wildly larger is almost certainly a regex
// false positive bleeding into a stream's binary content.
const MAX_PLAUSIBLE_PAGES = 100_000;

const HEAD_WINDOW = 1024 * 1024;   // 1 MB
const TAIL_WINDOW = 64 * 1024;     // 64 KB

/**
 * Module-scope decoder: TextDecoder is stateless across decode() calls and
 * cheap to reuse, so we pay the construction cost once instead of every read.
 */
const LATIN1_DECODER = new TextDecoder('latin1', { fatal: false });

/**
 * Extract the page count from a PDF binary. Returns null when the page tree
 * cannot be located (encrypted, fully-compressed object streams, malformed).
 *
 * The caller is expected to pass either the full file bytes (for small PDFs)
 * or a head + tail concatenation; either way, the page-tree root is normally
 * in the first ~1 MB of textual content or in the trailer area.
 */
export function countPdfPages(bytes: Uint8Array): number | null {
    if (bytes.length === 0) return null;

    // Scan window: first 1 MB plus last 64 KB of the buffer the caller gave us.
    // For small PDFs, the head window covers the entire file.
    const headEnd = Math.min(bytes.length, HEAD_WINDOW);
    const tailStart = Math.max(headEnd, bytes.length - TAIL_WINDOW);

    const head = LATIN1_DECODER.decode(bytes.subarray(0, headEnd));
    const tail = tailStart < bytes.length
        ? LATIN1_DECODER.decode(bytes.subarray(tailStart))
        : '';
    const text = head + tail;

    // Strategy 1: locate every page-tree dictionary and take the largest Count.
    let max = 0;
    for (const re of [TYPE_PAGES_THEN_COUNT, COUNT_THEN_TYPE_PAGES]) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
            const n = Number.parseInt(m[1], 10);
            if (Number.isFinite(n) && n > max && n <= MAX_PLAUSIBLE_PAGES) {
                max = n;
            }
        }
    }
    if (max > 0) return max;

    // Strategy 2: fall back to counting leaf /Type /Page objects.
    const leafMatches = text.match(LEAF_PAGE);
    if (leafMatches && leafMatches.length > 0 && leafMatches.length <= MAX_PLAUSIBLE_PAGES) {
        return leafMatches.length;
    }

    return null;
}
