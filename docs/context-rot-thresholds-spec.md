# Context-rot thresholds spec

Pinned 2026-04-28 for GET-28. Owner: Saar AI Usage Coach.

This document is the human-readable companion to
`lib/context-rot-thresholds.ts`. The runtime file is the source of truth
for the values; this document is the source of truth for **why** the
values are what they are. If Anthropic publishes new MRCR numbers or
ships new models, update both files together. The drift test in
`tests/unit/context-rot-thresholds.test.ts` will fail loudly if a
threshold changes without its provenance fields being updated.

## What problem are we solving

Saar's AI Usage Coach exists to teach claude.ai users that context rot
is real, that different models hit it at different points, and that
continuing past the rot zone produces unreliable answers (Claude
"hallucinates earlier details" because retrieval has degraded).

The previous health indicator used model-agnostic thresholds (70% warn,
90% critical). That was wrong: Sonnet 4.5 retrieves 18.5% at full
window while Opus 4.6 retrieves 76% at the same length. Treating them
identically pushed the wrong message at the wrong percentage.

GET-28 makes the threshold and the coaching copy per-model and grounds
both in Anthropic's published facts.

## Anthropic-published facts we rely on

These are the only externally-sourced figures used in the threshold
table. Every other number is a Saar coaching default (documented below).

### Fact 1: context rot is real and Anthropic acknowledges it

> "As token count grows, accuracy and recall degrade, a phenomenon known
> as *context rot*."

Source: https://platform.claude.com/docs/en/build-with-claude/context-windows

### Fact 2: MRCR scores at full window for Opus 4.6 and Sonnet 4.5

> "on the 8-needle 1M variant of MRCR v2, a needle-in-a-haystack
> benchmark that tests a model's ability to retrieve information
> 'hidden' in vast amounts of text, Opus 4.6 scores 76%, whereas
> Sonnet 4.5 scores just 18.5%."

Source: https://www.anthropic.com/news/claude-opus-4-6

### Fact 3: per-model context window sizes

From the same context-windows docs:

> "Claude Mythos Preview, Claude Opus 4.7, Claude Opus 4.6, and Claude
> Sonnet 4.6 have a 1M-token context window. Other Claude models,
> including Claude Sonnet 4.5 and Sonnet 4 (deprecated), have a 200k-token
> context window."

### Fact 4: server-side compaction availability

From the same docs page:

> "Compaction provides server-side summarization that automatically
> condenses earlier parts of a conversation, enabling long-running
> conversations beyond context limits with minimal integration work.
> It is currently available in beta for Claude Opus 4.7, Claude Opus 4.6,
> and Claude Sonnet 4.6."

This drives our coaching copy distinction: compaction-aware models get
softer "consider starting fresh" copy, non-compaction models get harder
"start a new chat now, use Projects" copy.

## What is NOT an Anthropic fact

The following are explicitly Saar coaching defaults, not Anthropic
claims. We say so in the runtime copy when relevant.

- Anthropic does not publish a rot CURVE. They publish endpoints (0% and
  100% utilization). Picking a "warn at 65%" or "critical at 75%" is
  Saar's coaching judgment, derived from those endpoints.
- Anthropic does not say "warn at X%" or "/compact at Y%". Anything
  resembling such a threshold in our copy is our recommendation, not a
  quote.
- Anthropic does not publish MRCR figures for Opus 4.7 or Sonnet 4.6.
  Our thresholds for those models extrapolate from siblings (Opus 4.6
  and Sonnet 4.5) and from Anthropic's qualitative claim that 4.6+
  models show "marked improvement" in long-context behavior.

## The threshold table

| Model prefix | Window | Warn | Crit | Detail-heavy adjust | MRCR @ 1M | Compaction |
|---|---|---|---|---|---|---|
| `claude-opus-4-7` | 1M | 65% | 85% | -15pp | not published | yes |
| `claude-opus-4-6` | 1M | 65% | 85% | -15pp | **76%** | yes |
| `claude-sonnet-4-6` | 1M | 60% | 80% | -15pp | not published | yes |
| `claude-sonnet-4-5` | 200k | 50% | 75% | -15pp | **18.5%** | no |
| `claude-haiku-4-5` | 200k | 50% | 75% | -15pp | not published | no |
| `claude-opus-4-5` | 200k | 50% | 75% | -15pp | not published | no |
| `claude-opus-4-1` | 200k | 50% | 75% | -15pp | not published | no |
| (unknown) | 200k | 50% | 75% | -15pp | not published | no |

Bolded MRCR values are Anthropic-published and pinned in
`sourceUrl` + `sourceQuote` fields on the matching profile row.

### Why these warn / critical numbers

**1M-window Opus models (warn 65, crit 85).** Opus 4.6 retrieves 76% of
hidden information at full 1M window. We treat that as "high-fidelity
retrieval still possible at the limit, so the rot zone starts late."
Warn at two-thirds utilization is a coaching choice that gives the user
room to act. Crit at 85 is a Saar default; 90% is the absolute floor
where any model is unreliable, so 85 leaves a 5pp buffer for the in-rot
warning to register before the absolute floor takes over. Opus 4.7
inherits the same numbers until Anthropic publishes a separate score.

**1M-window Sonnet 4.6 (warn 60, crit 80).** No Anthropic-published
MRCR. Anthropic markets Sonnet 4.6 as a long-context improvement over
4.5 but does not put a number on it. We picked thresholds between
Sonnet 4.5 (50/75) and Opus 4.6 (65/85) to reflect the "better than
its predecessor, not as good as Opus" qualitative position.

**200k-window Sonnet 4.5 (warn 50, crit 75).** Sonnet 4.5 retrieves
just 18.5% at 1M. While the user is on a 200k window (so they cannot
drive it to 1M directly), the curve implied by that endpoint suggests
accuracy is meaningfully degraded by half-window utilization. Warn at
50% is the half-window choice that matches the implied curve. Crit at
75 leaves a 15pp band for the user to react before the absolute floor.

**200k-window Haiku 4.5 (warn 50, crit 75).** No Anthropic-published
MRCR. Use the conservative 200k profile by default. Haiku is meant for
short, simple questions; in practice it rarely fills its window in a
chat session.

**Older 200k-window Opus models (4.5, 4.1).** Devanshu confirmed (GET-28
brief): nobody uses these on claude.ai today. We keep them in the table
so the indicator does not silently fall through to the unknown-model
fallback if anyone has them pinned.

### Why -15 percentage points for detail-heavy

Detail-heavy prompts (code blocks, precision keywords like "exact",
"verbatim", "list every") raise the cost of retrieval failure: the user
specifically wants Claude to find earlier details, so a degraded
retrieval rate matters more than for casual questions.

15 percentage points is the value documented in the GET-28 issue brief.
It moves the warning meaningfully earlier without flooding the user on
a normal Q&A. Detail-heavy never lowers a threshold below
`MIN_THRESHOLD_FLOOR` (30%), guarding against future tuning that stacks
multiple downward adjustments.

### Why an absolute critical floor at 90%

`ABSOLUTE_CRITICAL_FLOOR` = 90% is model-agnostic. Even on Opus 4.7,
once the user is at 90%+ of the window, retrieval is unreliable in
practice and the user is one large message away from a hard refusal.
The floor is a safety net so the indicator goes red even if a future
model is added without per-model thresholds.

## Coaching copy contract

Three zones, two model classes, optional MRCR citation. Generated by
`getRotCoaching(model, contextPct, isDetailHeavy)`.

### Healthy zone

- Below 30% context: "Conversation is fresh and responsive."
- 30%+ but under warn: "{N}% of {label}'s {window} window used. Plenty of room."

Low-friction. Names the model only when there is anything useful to say
beyond "fresh".

### Approaching zone (warn ≤ pct < crit)

The educational moment. Three components:

1. Lede: "Approaching the zone where retrieval declines."
2. MRCR clause when available: "On Anthropic's 8-needle 1M MRCR
   benchmark, {label} retrieves {N}% at full window."
3. Action:
   - Compaction-aware: "Anthropic's server-side compaction handles long
     sessions, but for accuracy-critical work consider starting a new
     chat."
   - Non-compaction: "For accuracy-critical work, start a new chat now."

### In-rot zone (pct ≥ crit, or pct ≥ ABSOLUTE_CRITICAL_FLOOR)

Direct, action-first.

- Compaction-aware: "{N}% used. Even with compaction, fine details
  from earlier may be missed. Start a new chat for new threads of work."
- Non-compaction: "{N}% used. Retrieval is unreliable here. Start a new
  chat. Use Projects to keep ongoing work organized."

### Things the copy never says

- `/compact`. That is a Claude Code slash command and does not exist
  on claude.ai web. Mentioning it would teach the wrong action.
- "Anthropic recommends starting fresh at X%." Anthropic does not
  publish that recommendation. The action is Saar's.
- A specific MRCR figure for any model whose profile does not carry
  one in `mrcrAt1MPct`. The copy generator omits the citation entirely
  when `mrcrAt1MPct` is undefined.

## Drift policy

When Anthropic publishes a new fact:

1. Update `lib/context-rot-thresholds.ts`. Add the new MRCR figure to
   the relevant profile's `mrcrAt1MPct`, `sourceUrl`, `sourceQuote`.
2. Update this spec doc with the verbatim quote and the source URL.
3. The drift test verifies that any profile with `mrcrAt1MPct` carries
   matching `sourceUrl` and `sourceQuote`, and that the quote contains
   the figure verbatim. If the test fails, fix the data, do not delete
   the assertion.

When Anthropic deprecates a model:

1. Keep the row in the table. Old extension installs may still see the
   model name on a stale tab.
2. Add a comment marking it deprecated. Do not silently delete; that
   would fall through to FALLBACK_PROFILE without explanation.

When a new model ships:

1. Add a row. Use the closest sibling's thresholds as defaults.
2. If Anthropic publishes an MRCR figure, fill in the provenance fields
   immediately.
3. Update the spec table above and the rationale paragraph.

## Out of scope (deferred to follow-up tickets)

- **Detail-heavy on the draft (pre-submit).** Today, we evaluate
  detail-heavy on the last *sent* prompt. Pre-submit detection on the
  draft would require plumbing the compose-box observer into the health
  recompute and is bigger scope. Cycle 2.
- **GET-36 fresh-session false-rot.** The suspected cause named in
  GET-36's body (`escalateForProjection` from a never-merged commit)
  does not exist on `main`. The bug, if reproducible on `main`, has a
  different root cause. Investigate after GET-28 lands.
- **"200% session %" calibration bug.** That is the weekly-cap display,
  not context rot. Separate ticket.
- **Visual rot-zone marker on the context bar.** A subtle tick at the
  warn threshold. Real value, but a UI ticket.
- **Empirical calibration via Anthropic's `count_tokens` endpoint.**
  Requires API-key plumbing and a privacy review.

## Sources

- Anthropic Opus 4.6 announcement (MRCR scores):
  https://www.anthropic.com/news/claude-opus-4-6
- Anthropic context-windows docs (rot acknowledgment, model windows,
  compaction availability):
  https://platform.claude.com/docs/en/build-with-claude/context-windows
- GET-28 Linear issue:
  https://linear.app/getsaar/issue/GET-28/context-rot-warning-per-model
- Verified live on 2026-04-28 against the live pages above.
