# lco — Local Context Optimizer

**Claude strips token counts from its web UI. You're flying blind on cost and context.**
lco intercepts the SSE stream before that data disappears, counts tokens locally with Anthropic's own BPE vocabulary, and renders what you're spending in a live overlay — zero data leaves your machine.

---

## The problem

Every Claude request fires an SSE stream. That stream contains your token counts, stop reasons, and usage cap data. Claude's web UI discards all of it before rendering.

The result: you have no idea how fast you're burning through context, how much each conversation costs, or when you're about to hit your message limit.

Here's what a semester of heavy Claude usage looks like with no visibility:

```
March invoice: $247.83
April invoice: $189.42
"I thought I was being careful." — every developer, every month
```

The pattern that kills budgets: context accumulation. You start a conversation, paste in a codebase, iterate for two hours. By the end, you're sending 40,000 tokens of context per message — and you never knew.

---

## What lco does

Installs as a Chrome extension. Runs entirely locally. Intercepts Claude's completion API stream before the UI strips the data. Counts tokens using the same BPE model Claude uses. Shows you what's happening in real time.

```
┌─ LCO ──────────────────────────────────┐
│ claude-sonnet-4-6                       │
│ 2,847 in / 1,203 out   $0.0267          │
│ ████████████░░░░░░░░░░░░  18% context   │
│ Session: 4 requests · $0.11             │
└─────────────────────────────────────────┘
```

What you get:

- **Live token counts** — input and output update every 200ms as Claude responds
- **Per-request cost** — calculated at stream end with accurate BPE counts
- **Context window bar** — how much of the 200K window this conversation uses
- **Session totals** — cumulative cost and request count for the tab
- **Message limit bar** — fills amber as you approach Claude's usage cap (exact, from the API itself)

---

## How it works

Three isolated JavaScript contexts. One validated message bus. One overlay.

```
┌──────────────────────────────────────────────────────────────────┐
│  Room 1: MAIN World  (inject.ts)                                 │
│  Intercepts window.fetch. Tees the SSE stream with .tee().       │
│  Decodes events every 200ms. Posts batches via postMessage.      │
└────────────────────────┬─────────────────────────────────────────┘
                         │ postMessage (namespace + session token)
┌────────────────────────▼─────────────────────────────────────────┐
│  Room 2: Content Script  (claude-ai.content.ts)                  │
│  5-layer validation on every message. Forwards to Room 3.        │
│  Renders the overlay in a closed Shadow DOM.                     │
└────────────────────────┬─────────────────────────────────────────┘
                         │ chrome.runtime.sendMessage
┌────────────────────────▼─────────────────────────────────────────┐
│  Room 3: Service Worker  (background.ts)                         │
│  Runs js-tiktoken with Anthropic's BPE vocab (claude.json).      │
│  Writes per-tab state to chrome.storage.session.                 │
│  Computes cost. Cleans up storage on tab close.                  │
└──────────────────────────────────────────────────────────────────┘
```

**Why three contexts?** Chrome Extensions MV3 enforces this separation. The page's JS runs in the MAIN world — the extension cannot reach it directly. The content script runs alongside the page but cannot use `chrome.*` APIs. The service worker has full `chrome.*` access but no DOM. Data flows one-way through validated channels.

### The fetch intercept

```javascript
// inject.ts — runs inside claude.ai's page context
const originalFetch = window.fetch;

window.fetch = async function (input, init) {
  const url = typeof input === 'string' ? input : input.url;

  if (isCompletionEndpoint(url)) {
    const response = await originalFetch.call(this, input, init);

    if (response.body) {
      // .tee() duplicates the stream — one for Claude's UI, one for lco.
      // Claude's page gets an identical stream and never knows we were here.
      const [pageStream, monitorStream] = response.body.tee();
      decodeSSEStream(monitorStream, model, prompt);
      return new Response(pageStream, response);
    }
  }

  return originalFetch.call(this, input, init);
};
```

### The 5-layer bridge

Every `postMessage` from Room 1 passes five checks before Room 2 forwards anything:

```typescript
// 1. Origin must be claude.ai — blocks messages from other pages
if (event.origin !== 'https://claude.ai') return;

// 2. Source must be the same window — blocks cross-frame injection
if (event.source !== window) return;

// 3. Namespace must match — LCO_V1 is the shared contract
if (event.data?.namespace !== 'LCO_V1') return;

// 4. Session token must match — fresh UUID v4 generated per page load
if (event.data.token !== sessionToken) return;

// 5. Schema validation — correct type, required fields, correct value types
if (!isValidBridgeSchema(event.data)) return;
```

All five must pass or the message is silently dropped. This isn't paranoia — content scripts process every `postMessage` from the page, and pages can post arbitrary data.

### Token counting

During streaming, lco uses `chars / 4` for real-time display (fast, synchronous, approximate). When the stream ends, it fires accurate BPE counts:

```typescript
// Stream complete: full accumulated text goes to the service worker
const [inputCount, outputCount] = await Promise.all([
  countTokens(promptText),      // accurate BPE via js-tiktoken
  countTokens(outputTextBuffer),
]);

// Fall back to chars/4 if BPE counting fails
if (inputCount > 0) summary.inputTokens = inputCount;
if (outputCount > 0) summary.outputTokens = outputCount;
```

The tokenizer uses Anthropic's actual `claude.json` BPE vocabulary from `@anthropic-ai/tokenizer`. Same vocab Claude uses. Runs in the service worker, off the main thread. Cold start on first message: ~20-40ms. Warm: negligible.

---

## Pricing (current)

| Model | Input | Output | Context |
|-------|-------|--------|---------|
| claude-opus-4-6 | $5 / 1M tokens | $25 / 1M tokens | 200K |
| claude-sonnet-4-6 | $3 / 1M tokens | $15 / 1M tokens | 200K |
| claude-haiku-4-5 | $1 / 1M tokens | $5 / 1M tokens | 200K |

Cost is calculated per-request at stream end and accumulated per tab in `chrome.storage.session`. Session storage clears automatically when the browser closes. No persistence.

---

## Quick start

**Prerequisites:** Node 20+, Bun, Chrome

```bash
git clone https://github.com/OpenCodeIntel/lco
cd lco
bun install
bun run build
```

Load in Chrome:

1. Navigate to `chrome://extensions`
2. Toggle **Developer mode** (top-right)
3. Click **Load unpacked** → select `.output/chrome-mv3`
4. Open `claude.ai` — a banner asks to enable LCO on first visit

The overlay appears in the bottom-right corner of the page.

For development with hot reload:

```bash
bun run dev
```

Load `.output/chrome-mv3` once. Changes to source files reload automatically.

See [SETUP.md](SETUP.md) for troubleshooting and verification steps.

---

## What's not built yet

- **Only claude.ai.** The architecture supports adding providers (`lib/adapters/`), but no other adapter exists yet.
- **No prompt compression guidance.** lco observes and reports. It does not yet tell you when to start a new chat or how to reduce context waste.
- **No persistent history.** Everything lives in `chrome.storage.session`. Clears when the browser closes. No charts over time.
- **No Firefox.** Works on Chrome and Chromium-based browsers. Firefox MV2/MV3 support is on the list.
- **chars/4 is approximate.** Real-time display during streaming uses character count divided by four. Close for English prose, rougher for dense code. The final count (post-stream) is accurate BPE.
- **Context % is per-request, not per-conversation.** We see what each API call sends. Claude maintains conversation history server-side — we can only measure what comes through the stream.

---

## Privacy

Everything runs in your browser. No servers. No accounts. No telemetry.

Your prompt text is processed in memory by the local BPE tokenizer to produce a token count. It is never written to disk and never transmitted anywhere. `chrome.storage.session` holds token counts and costs only — not prompt content.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to help and what's currently hard.

See [ARCHITECTURE.md](ARCHITECTURE.md) for a full technical walkthrough.

---

## License

MIT
