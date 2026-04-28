# Attachment Cost Spec

Token cost math for image and PDF attachments in the pre-submit estimate. This file
is the source of truth for `lib/attachment-cost.ts` and the drift tests in
`tests/unit/attachment-cost.test.ts`. If Anthropic publishes a different formula or
caps, update this file in the same PR that updates the code.

Last verified against Anthropic docs: 2026-04-26.

Sources:
- https://platform.claude.com/docs/en/build-with-claude/vision
- https://platform.claude.com/docs/en/build-with-claude/pdf-support

## Image cost

### Formula (verbatim)

> An image uses approximately `width * height / 750` tokens, where the width and
> height are expressed in pixels.

### Per-model resolution caps (verbatim)

> The maximal native image resolution is:
> - For Claude Opus 4.7: 4784 tokens, and at most 2576 pixels on the long edge.
> - For other models: 1568 tokens, and at most 1568 pixels on the long edge.

When the long edge exceeds the per-model cap, Anthropic resizes the image
preserving aspect ratio, then computes the formula. The result is also clamped
to the per-model max-tokens cap.

### Algorithm

```
maxLongPx, maxTokens =
  Opus 4.7  -> (2576, 4784)
  others    -> (1568, 1568)

if max(w, h) > maxLongPx:
    scale = maxLongPx / max(w, h)
    w' = round(w * scale)
    h' = round(h * scale)
else:
    w', h' = w, h

tokens = min(round(w' * h' / 750), maxTokens)
```

### Verification table (Sonnet 4.6, max 1568 px / 1568 tokens)

| Input pixels | Anthropic published | Our formula |
|---|---|---|
| 200 x 200 | ~54 | 53 |
| 1000 x 1000 | ~1334 | 1333 |
| 1092 x 1092 | ~1568 | 1590 capped to 1568 |
| 1920 x 1080 | ~1568 (downscaled) | resized to 1568 x 882, 1844 capped to 1568 |
| 2000 x 1500 | ~1568 (downscaled) | resized to 1568 x 1176, 2459 capped to 1568 |

### Verification table (Opus 4.7, max 2576 px / 4784 tokens)

| Input pixels | Anthropic published | Our formula |
|---|---|---|
| 200 x 200 | ~54 | 53 |
| 1000 x 1000 | ~1334 | 1333 |
| 1092 x 1092 | ~1590 | 1590 |
| 1920 x 1080 | ~2765 | 2765 |
| 2000 x 1500 | ~4000 | 4000 |

Every row in both tables is asserted by `tests/unit/attachment-cost.test.ts`. If
Anthropic changes the formula or the caps, those tests fail and we re-derive.

### Expected error vs real API

Sub 5 percent. The formula is deterministic. The only fuzz comes from
Anthropic's word "approximately" and any off-by-one differences in their
internal rounding. We have not seen a case where our prediction misses the
published example by more than one token.

### Models with no published image support

Returns `null` for image tokens. The caller renders `?` and skips adding to
the total. Today every Claude model in `assets/pricing.json` supports vision,
so this branch is defensive.

## PDF cost

### What Anthropic actually publishes

Two cost components, additive (verbatim):

> Text token costs: Each page typically uses 1,500-3,000 tokens per page
> depending on content density. Standard API pricing applies with no additional
> PDF fees.
>
> Image token costs: Since each page is converted into an image, the same
> image-based cost calculations are applied.

Anthropic does not publish:
- The DPI used when rendering each PDF page to an image.
- A per-page image-token formula independent of DPI.
- A combined per-page total.

The only published combined-cost data point is from the Bedrock section of the
PDF doc:
- Document Chat (text-only fallback): 1,000 tokens for 3 pages (~333 / page).
- Claude PDF Chat (full visual): 7,000 tokens for 3 pages (~2,333 / page).

### Our policy

Surface the published 1,500-3,000 range as a low-high pair. Never collapse to
a midpoint. The overlay shows the range. The drift tests assert the constants
verbatim.

```
PDF_TOKENS_PER_PAGE_LOW  = 1500
PDF_TOKENS_PER_PAGE_HIGH = 3000
```

For a PDF with N pages: low = N * 1500, high = N * 3000.

The image-per-page contribution is real but unquantifiable from public data.
We disclose this once, in the overlay, as: "PDFs with charts may cost more".
Nothing more elaborate. We will not invent a DPI or interpolate from Bedrock.

### Inherent error band

Plus or minus 33 percent from Anthropic's own published range, plus an
unmeasurable amount for the per-page image rendering. This is a property of
the document, not a property of our code. We cannot fix it; we can only
report it honestly.

### Hard limits (verified)

| Limit | Value | Applies to |
|---|---|---|
| Pages per request | 600 | 1M-context models |
| Pages per request | 100 | 200K-context models |
| Total request size | 32 MB | All |
| Format | Standard PDF, no passwords or encryption | All |

When attached page count exceeds the per-model cap, the agent emits a hard
warning: "<N> pages exceeds the <cap>-page limit on this model".

## Page-count parsing

We extract the page count locally without a heavy PDF library. The
`lib/pdf-page-count.ts` module scans the PDF binary for the page tree root
and reads its `/Count` entry. Falls back to counting individual `/Type /Page`
objects when the root is not findable.

Returns `null` for:
- Encrypted PDFs (no `/Encrypt` decoder).
- PDFs whose page tree lives entirely inside compressed object streams.
- Malformed files.

When `null`, the overlay shows `?` for the page count and omits the PDF from
the cost estimate. The user still sees the file is attached.

### Why not pdfjs-dist

The official pdf.js library is the canonical parser, but in an MV3 service
worker or content-script bundle it costs ~600 KB gzipped and brings DOM
dependencies that complicate the build. For a one-shot page-count read we
do not need PDF parsing depth; the page-tree regex is good enough for ~95
percent of standard PDFs and ships in 30 lines with no dependency footprint.

If accuracy ever matters (encrypted PDFs, fully-compressed page trees), we
swap in pdfjs-dist via an offscreen document. Filed as a Wave-2 follow-up.

## General hard limits (verified)

Reused by the cost agent for warnings on both kinds of attachments.

| Limit | Value | Source |
|---|---|---|
| Image dimensions | 8000 x 8000 px | Vision doc, "General limits" |
| Image dimensions when more than 20 images | 2000 x 2000 px | Same |
| Image file size | 5 MB API, 10 MB claude.ai | Vision FAQ |
| Images per request | 100 (200K models) / 600 (1M models) | Vision doc |
| Image formats | JPEG, PNG, GIF, WebP | Vision FAQ |
| Total request size | 32 MB | PDF doc, "Maximum request size" |

## Active warning thresholds

These are the points at which the agent surfaces a hard warning. The numbers
are pinned by tests; tighten only if Anthropic publishes a stricter limit.

| Warning | Trigger | Source / rationale |
|---|---|---|
| PDF page-cap exceeded | total PDF pages > 600 (1M context) or > 100 (200K context) | Anthropic verbatim |
| Aggregate request size approaching cap | total attachment bytes > 30 MB | 2 MB margin under the 32 MB hard cap for prompt body and JSON overhead |
| Aggregate request size exceeds cap | total attachment bytes > 32 MB | Anthropic hard cap |
| Context-window overrun | projected (history + draft + attachments high) >= 90 % of context window | Anthropic explicit caveat: "Dense PDFs can fill the context window before reaching the page limit" |
| Session projection over 90 % | currentSessionPct + estimatedSessionPct (low) >= 90 % | Existing pre-submit warning |

Coaching copy mirrors Anthropic's own published advice: "Try splitting the
document into sections; for large files, since each page is processed as an
image, downsampling embedded images can also help."

## Empirical calibration (Wave-2)

The honest path to single-percent accuracy is the Anthropic `count_tokens`
endpoint. Sending the actual prompt + attachments returns the real input
token count, no estimation. That requires API-key plumbing, a request
budget, and a privacy review. Not in scope for this issue. Filed separately
when Wave-1 has shipped.

## Drift policy

Update this file in lockstep with `lib/attachment-cost.ts`. The unit tests
treat every number in the verification tables above as ground truth. If a
test fails, the assumption is that Anthropic has changed something; refetch
the docs, update this file, update the constants, ship together.
