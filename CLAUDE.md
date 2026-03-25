# LCO — Local Context Optimizer

Chrome extension (WXT + TypeScript) that intercepts SSE streams on claude.ai, counts tokens via local BPE, calculates cost, and displays it in a non-intrusive Shadow DOM overlay.

## Architecture

Three isolated JS execution contexts connected by message passing:

**Room 1 — MAIN World** (`entrypoints/inject.ts`)
Runs inside claude.ai's page JS. Intercepts `window.fetch`, tees the SSE stream, decodes events, accumulates text in sync buffer, posts batches every 200ms to Room 2. Self-contained IIFE — no imports from lib/. Injected at `document_start` via WXT `injectScript()`.

**Room 2 — Content Script** (`entrypoints/claude-ai.content.ts`)
Extension's isolated world. Generates session token, injects Room 1, validates all incoming postMessages (5 layers: origin, source, namespace LCO_V1, session token, schema), forwards to Room 3. Renders vanilla DOM overlay in closed Shadow DOM. Bridges BPE counting between Room 1 and Room 3.

**Room 3 — Service Worker** (`entrypoints/background.ts`)
Background worker. Runs `js-tiktoken` with `@anthropic-ai/tokenizer` claude.json BPE vocab. Handles COUNT_TOKENS, writes per-tab state to `chrome.storage.session`, calculates cost via `lib/pricing.ts`, manages tab cleanup + orphan alarm.

## Key Technical Decisions

- **Vanilla DOM overlay, not React.** WXT silently strips React from content scripts at document_start. Vanilla DOM eliminates the bundling issue and is faster for a small widget.
- **Local BPE tokenization.** Claude's web UI strips token counts from SSE stream. js-tiktoken + claude.json is the only option. All counts are approximate (~prefix).
- **Model name from request body.** Response `message.model` is empty string on web UI.
- **Endpoint:** `/chat_conversations/{uuid}/completion`
- **`message_limit` event** provides exact usage cap utilization from Anthropic — free, no tokenizer needed.
- **Session = per-tab accumulator.** `sessionCost_{tabId}` tracks across conversations in the same tab.

## Pricing (March 2026)

| Model | Input/M | Output/M |
|-------|---------|----------|
| Opus 4.6 | $5 | $25 |
| Sonnet 4.6 | $3 | $15 |
| Haiku 4.5 | $1 | $5 |

## Conventions

- Types in `lib/message-types.ts`. Platform attribution from `sender.url` (unforgeable).
- postMessage: always `window.location.origin`, never `'*'`.
- 200ms batching on postMessage and storage writes.
- inject.ts: no imports, no chrome.* refs, all constants inlined.
- Token counting: sync chars/4 during stream, accurate BPE once at stream end.
- Unknown models: return null, show `$0.00*`, never crash.
- Service worker: all listeners synchronous at top level, async inside handlers.
- Tests: `bun run test`. Commits: `type(scope): description [LCO-XXX]`.
- No emojis anywhere in code, comments, or docs.
- No emdashes in comments or docs. Use colons, semicolons, or rewrite the sentence.
- No AI-generated filler ("it's worth noting", "leveraging", "utilize"). Write like a human.

## Current Status

```
Done:
  LCO-1   Data Pipeline Foundation (SSE intercept, bridge, storage, tokenizer)
  LCO-2   Shadow DOM UI Overlay (vanilla DOM, frosted glass HUD)
  LCO-3   Live Data Wiring (TOKEN_BATCH, STREAM_COMPLETE, message_limit, session totals)
  LCO-4   CI/CD Pipeline (GitHub Actions: typecheck, test, build)
  LCO-5   JIT Permission System (optional_host_permissions, enable banner, runtime request)
  LCO-6   End-to-End Testing (7 manual scenarios, 2 bugs fixed)
  LCO-17  Dead Code Cleanup (unused types, stubs, premature ChatGPT refs)

In Progress:
  LCO-7   Chrome Web Store Submission (docs done, store assets + submission pending)

Remaining:
  LCO-14  Provider Abstraction Layer (multi-platform architecture)
  LCO-15  Health Check System (SSE lifecycle monitoring)
  LCO-16  Test Coverage (SSE decoder, batch flush, health detection)
```

Full backlog tracked in Linear (team: LCO, issues LCO-8 through LCO-26).
