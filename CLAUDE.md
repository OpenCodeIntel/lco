# LCO — Local Context Optimizer

Chrome extension (WXT + TypeScript + React) that intercepts SSE streams on claude.ai, counts tokens via local BPE, calculates cost, and displays it in a non-intrusive overlay.

## Architecture

Three isolated JS execution contexts connected by message passing:

**Room 1 — MAIN World** (`entrypoints/inject.ts`)
Runs inside claude.ai's page JS. Intercepts `window.fetch`, tees the SSE stream, decodes events, accumulates text, posts batches every 200ms to Room 2. Self-contained IIFE — no imports from lib/ (would leak chrome.* refs). Injected at `document_start` via WXT `injectScript()`.

**Room 2 — Content Script** (`entrypoints/claude-ai.content.ts`)
Extension's isolated world. Generates session token, injects Room 1, validates all incoming postMessages (5 layers: origin, source, namespace LCO_V1, session token, schema), forwards to Room 3. Also bridges BPE token counting requests between Room 1 and Room 3.

**Room 3 — Service Worker** (`entrypoints/background.ts`)
Background worker. Runs `js-tiktoken` with `@anthropic-ai/tokenizer` claude.json BPE vocab. Handles COUNT_TOKENS requests, writes per-tab state to `chrome.storage.session`, calculates cost via `lib/pricing.ts`, manages tab cleanup + orphan alarm.

## Data Flow (Single Request)

```
User sends prompt on claude.ai
→ [Room 1] fetch interceptor catches /chat_conversations/{uuid}/completion
→ [Room 1] response.body.tee() — branch 1 to page, branch 2 to decoder
→ [Room 1] SSE decoder: accumulates delta text in outputTextBuffer (sync)
→ [Room 1] Every 200ms: posts TOKEN_BATCH with chars/4 estimate to Room 2
→ [Room 1] On stream end: sends promptText + outputTextBuffer to Room 3 for BPE count
→ [Room 1] Posts STREAM_COMPLETE with accurate BPE counts
→ [Room 2] Validates 5 layers, forwards STORE_TOKEN_BATCH to Room 3
→ [Room 3] Looks up model pricing, calculates cost, writes tabState + sessionCost
→ [Room 1] message_limit event → Room 2 → Room 3 → writes utilization to tabState
```

## Empirical Facts (Verified March 2026)

These are ground truth from inspecting live claude.ai SSE responses:

1. **Web UI strips token counts.** `message_start` has NO `usage.input_tokens`. `message_delta` has NO `usage.output_tokens`. Local BPE tokenization is the only option. All counts are approximate (~prefix).

2. **Model name from request body, not response.** `message_start.message.model` is `""` on the web UI. Read from the request payload `parsed.model` field.

3. **Endpoint is `/chat_conversations/{uuid}/completion`**, not `/api/append_message`.

4. **`message_limit` event has exact usage cap data.** `utilization: 0.48` = 48% of limit used. Free from Anthropic. Already parsed and stored.

5. **`fetch` on claude.ai is already patched** (DataDog/Intercom, ~241 chars). Our IIFE wraps their wrapper. Chain: our wrapper → their wrapper → native.

6. **CSP is irrelevant.** Claude uses SHA256-hash meta CSP. `chrome.scripting.executeScript` with `world: MAIN` bypasses it entirely.

## Pricing (Verified March 2026)

| Model | Input/M | Output/M | Per-token input | Per-token output |
|-------|---------|----------|-----------------|------------------|
| Opus 4.6 | $5 | $25 | 0.000005 | 0.000025 |
| Sonnet 4.6 | $3 | $15 | 0.000003 | 0.000015 |
| Haiku 4.5 | $1 | $5 | 0.000001 | 0.000005 |

Pricing data bundled in `assets/pricing.json`. Includes dated variants and short aliases.

## File Map

```
entrypoints/
  inject.ts              Room 1: MAIN world fetch interceptor + SSE decoder
  claude-ai.content.ts   Room 2: content script, bridge, session token
  background.ts          Room 3: service worker, tokenizer, storage, pricing
lib/
  message-types.ts       All TypeScript interfaces + LCO_NAMESPACE constant
  pricing.ts             lookupModel(), calculateCost(), getContextWindowSize()
  platform-config.ts     Provider endpoint configs (not imported by inject.ts)
assets/
  pricing.json           Bundled model pricing data
tests/
  unit/
    message-security.test.ts   5-layer bridge validation tests
    tab-storage.test.ts        Multi-tab storage isolation + cleanup tests
    pricing.test.ts            Pricing lookup + cost calculation tests
  integration/
    ipc-pipeline.test.ts       Cross-room message pipeline test
```

## Storage Schema

```
chrome.storage.session:
  tabState_{tabId}    → { platform, model, inputTokens, outputTokens, stopReason, messageLimitUtilization?, updatedAt }
  sessionCost_{tabId} → { totalInputTokens, totalOutputTokens, requestCount, estimatedCost?, updatedAt }
  sessionToken_{host} → string (UUID, one per page load)
```

Flat per-tab keys. No nested global objects. No race conditions between tabs.

## Conventions

- **Types:** All cross-room messages defined in `lib/message-types.ts`. Add new message types there.
- **Platform attribution:** Always from `sender.url` in Room 3 (set by Chrome, unforgeable). Never from self-reported `message.platform`.
- **postMessage security:** Always `window.location.origin` as target. Never `'*'`.
- **Batching:** 200ms on both postMessage and `chrome.storage.session` writes.
- **inject.ts isolation:** No imports from `lib/`. All constants inlined. No `chrome.*` refs.
- **Token counting:** Synchronous `chars/4` estimate during streaming for real-time UI. Accurate BPE count via `countTokens()` once at stream end.
- **Unknown models:** `lookupModel()` returns `null`. `calculateCost()` returns `null`. UI shows `$0.00*`. Never crash.
- **Service worker lifecycle:** All listeners registered synchronously at top level. Async work awaited inside handlers. `return true` for any handler using `sendResponse` asynchronously.
- **Tab cleanup:** `tabs.onRemoved` cleans storage. `alarms` (every 5min) cleans orphans.
- **Tests:** `bun run test` (vitest). Unit tests in `tests/unit/`, integration in `tests/integration/`.
- **Commits:** `type(scope): description [LCO-XXX]` — e.g. `feat(ui): add shadow DOM overlay [LCO-201]`

## Current Status

```
✅ Step 1: WXT project setup (persistent dev profile, MV3 manifest)
✅ Step 2: SSE prototype (fetch intercept, tee, decode on claude.ai)
✅ Step 3: postMessage bridge (5-layer security, 200ms batching)
✅ Step 4: Service worker (tokenizer preload, tab storage, cleanup)
✅ Step 5: Pricing engine (lookupModel, calculateCost, wired into background)
✅ Security fix: wildcard postMessage origins → window.location.origin
✅ Performance fix: blocking await → sync text buffer + final BPE count
✅ Feature: message_limit event parsed + stored (usage cap utilization)
⬜ Step 6: Shadow DOM UI overlay
⬜ Step 7: Wire live data to overlay
⬜ Step 8: CI/CD pipeline
⬜ Step 9: JIT permission system
⬜ Step 10: End-to-end testing
```

## Next: Step 6 — Shadow DOM UI Overlay

Build `ui/TokenOverlay.tsx` + `ui/overlay.css`. Inject as direct child of `document.body` inside closed Shadow DOM. Display: ~input tokens, ~output tokens, ~cost, message limit %, session total. Position fixed bottom-right. CSS variables for dark/light mode. React component rendered via `createRoot` inside shadow root. Detect SPA navigation via `navigation.onnavigatesuccess`. 800ms debounce on any MutationObserver. No external UI libraries for the overlay — plain React + CSS. Phase 2 popup page will use shadcn/ui.
