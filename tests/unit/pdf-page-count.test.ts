import { describe, it, expect } from 'vitest';
import { countPdfPages } from '../../lib/pdf-page-count';

/**
 * PDFs are byte-oriented but the textual scaffolding we parse is ASCII. Map
 * each char to its byte to build a fixture without depending on TextEncoder
 * (which is utf-8-only and would corrupt non-ASCII test inputs).
 */
function pdfBytes(text: string): Uint8Array {
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
    return out;
}

const minimalPdf = (count: number): string => `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count ${count} >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>
endobj
xref
0 4
0000000000 65535 f
0000000009 00000 n
0000000045 00000 n
0000000095 00000 n
trailer
<< /Size 4 /Root 1 0 R >>
startxref
0
%%EOF
`;

describe('countPdfPages: page-tree root', () => {
    it.each([1, 8, 100, 600])('returns Count from /Type /Pages root (%d pages)', (n) => {
        expect(countPdfPages(pdfBytes(minimalPdf(n)))).toBe(n);
    });

    it('handles reverse key ordering (Count before Type Pages)', () => {
        const text = `%PDF-1.4
2 0 obj
<< /Count 12 /Type /Pages /Kids [3 0 R] >>
endobj
%%EOF
`;
        expect(countPdfPages(pdfBytes(text))).toBe(12);
    });

    it('picks the maximum Count across intermediate page-tree nodes', () => {
        const text = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R 4 0 R] /Count 5 >> endobj
3 0 obj << /Type /Pages /Kids [5 0 R 6 0 R] /Count 2 >> endobj
4 0 obj << /Type /Page /Parent 2 0 R >> endobj
5 0 obj << /Type /Page /Parent 3 0 R >> endobj
6 0 obj << /Type /Page /Parent 3 0 R >> endobj
trailer << /Size 7 /Root 1 0 R >>
%%EOF
`;
        expect(countPdfPages(pdfBytes(text))).toBe(5);
    });
});

describe('countPdfPages: leaf-page fallback', () => {
    it('counts /Type /Page leaves when no /Pages root is present', () => {
        const text = `%PDF-1.4
1 0 obj << /Type /Page >> endobj
2 0 obj << /Type /Page >> endobj
3 0 obj << /Type /Page >> endobj
%%EOF
`;
        expect(countPdfPages(pdfBytes(text))).toBe(3);
    });

    it('does not match /Type /Pages as a leaf page', () => {
        // Only a Pages root, no leaves. Strategy 1 finds Count via the root.
        const text = `%PDF-1.4
2 0 obj << /Type /Pages /Count 7 >> endobj
%%EOF
`;
        expect(countPdfPages(pdfBytes(text))).toBe(7);
    });
});

describe('countPdfPages: failure modes', () => {
    it('returns null on empty input', () => {
        expect(countPdfPages(new Uint8Array(0))).toBeNull();
    });

    it('returns null on non-PDF garbage input', () => {
        expect(countPdfPages(pdfBytes('not a pdf at all'))).toBeNull();
    });

    it('returns null when no page tree or leaves can be found', () => {
        const text = `%PDF-1.4
2 0 obj << /Type /Catalog >> endobj
%%EOF
`;
        expect(countPdfPages(pdfBytes(text))).toBeNull();
    });

    it('rejects implausibly large Count values (regex false positives)', () => {
        // A binary stream might happen to contain "/Count 999999999" by chance.
        // The MAX_PLAUSIBLE_PAGES sanity gate filters it out.
        const text = `%PDF-1.4
2 0 obj << /Type /Pages /Count 999999999 >> endobj
%%EOF
`;
        expect(countPdfPages(pdfBytes(text))).toBeNull();
    });
});
