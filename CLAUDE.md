# LCO: Local Context Optimizer

Chrome extension (WXT + TypeScript) that intercepts SSE streams on claude.ai, counts tokens via local BPE, calculates cost, and displays it in a non-intrusive Shadow DOM overlay.

## Product Vision

LCO is not just a token counter. The goal is to gamify the context window problem: help users see how their AI conversations consume context, teach them when to start a new chat, when to use Claude Projects, and how to write more efficient prompts. A fitness tracker for AI usage.

Claude.ai first. Get it perfect here, then the architecture supports new platforms by dropping in an adapter file.

## Architecture

Three isolated JS execution contexts connected by message passing.

**Room 1: MAIN World** (`entrypoints/inject.ts`)
Runs inside claude.ai's page JS. Intercepts `window.fetch`, tees the SSE stream, decodes events, accumulates text in a sync buffer, posts batches every 200ms to Room 2. Self-contained IIFE: no imports from lib/, no chrome.* refs, all constants inlined. Injected at `document_start` via WXT `injectScript()`.

**Room 2: Content Script** (`entrypoints/claude-ai.content.ts`)
Extension's isolated world. Generates session token, injects Room 1, validates all incoming postMessages (5 layers: origin, source, namespace LCO_V1, session token, schema), forwards to Room 3. Renders vanilla DOM overlay in closed Shadow DOM. Bridges BPE counting between Room 1 and Room 3.

**Room 3: Service Worker** (`entrypoints/background.ts`)
Background worker. Runs `js-tiktoken` with `@anthropic-ai/tokenizer` claude.json BPE vocab. Handles COUNT_TOKENS, writes per-tab state to `chrome.storage.session`, calculates cost via `lib/pricing.ts`, manages tab cleanup + orphan alarm.

## Separation of Concerns

Each concern gets its own module. When adding a feature, ask: "Which layer does this belong to?" If the answer is two layers, split it.

- **Data pipeline** (inject.ts, background.ts): SSE intercept, token counting, storage. Do not add business logic here.
- **Message bridge** (content script core): Validation and forwarding. Thin relay only.
- **Overlay rendering** (ui/): DOM creation, styling, animations. No business logic.
- **Intelligence layer** (lib/): Context analysis, threshold detection, coaching rules. Pure functions, no DOM refs.
- **Nudge system** (future): User-facing suggestions rendered by the overlay, driven by the intelligence layer.

## Key Technical Decisions

- **Vanilla DOM overlay, not React.** WXT silently strips React from content scripts at document_start. Vanilla DOM eliminates the bundling issue and is faster for a small widget.
- **Local BPE tokenization.** Claude's web UI strips token counts from the SSE stream. js-tiktoken + claude.json is the only option. All counts are approximate (~prefix).
- **Model name from request body.** Response `message.model` is empty string on the web UI.
- **Endpoint:** `/chat_conversations/{uuid}/completion`
- **`message_limit` event** provides exact usage cap utilization from Anthropic; free, no tokenizer needed.
- **Session = per-tab accumulator.** `sessionCost_{tabId}` tracks across conversations in the same tab.
- **5-layer bridge security.** Origin check, source check, namespace (`LCO_V1`), session token (UUID v4 per load), schema validation. All five must pass or the message is dropped.
- **Platform attribution from `sender.url`** (set by Chrome, unforgeable). Never trust self-reported platform strings.

## Pricing (March 2026)

| Model | Input/M | Output/M |
|-------|---------|----------|
| Opus 4.6 | $5 | $25 |
| Sonnet 4.6 | $3 | $15 |
| Haiku 4.5 | $1 | $5 |

## Conventions

### Code Quality (non-negotiable)
- Production-grade code only. Every line ships.
- No emojis anywhere: code, comments, docs, commit messages.
- No emdashes. Use colons, semicolons, or rewrite the sentence.
- No AI filler ("it's worth noting", "leveraging", "utilize", "robust", "seamless", "comprehensive"). Write like a human.
- No speculative code. No stubs, placeholders, or "future-proofing" for features that do not exist yet.
- No unnecessary abstractions. Three similar lines beat a premature helper.
- If unsure about a design decision, stop and ask. Do not guess.

### Architecture Rules
- Types live in `lib/message-types.ts`.
- postMessage target: always `window.location.origin`, never `'*'`.
- 200ms batching on postMessage and storage writes.
- inject.ts: no imports, no chrome.* refs, all constants inlined.
- Token counting: sync chars/4 during stream, accurate BPE at stream end.
- Unknown models: return null cost, show `$0.00*` in overlay, never crash.
- Service worker: all listeners synchronous at top level, async inside handlers.

### Workflow
- Tests: `bun run test`.
- Typecheck: `bun run typecheck`.
- Build: `bun run build`.
- Commits: `type(scope): description [LCO-XXX]`. No Co-Authored-By lines.
- Branches: `feat/lco-XX-short-description`.
- One PR at a time. Open in browser after creating.
- Always run typecheck, test, and build before declaring something done.

### Tracking
- All issue status lives in Linear (team: LCO). Never duplicate status in this file.
- If you need current status, check Linear or git log.
