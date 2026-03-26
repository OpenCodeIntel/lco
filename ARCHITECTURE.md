# Architecture

lco intercepts, decodes, stores, and displays — in that order, across three isolated JavaScript contexts that cannot directly communicate.

This document explains why each piece works the way it does and where the constraints come from.

---

## The three-room model

Chrome Extensions MV3 enforces strict context separation. Three different JavaScript sandboxes run simultaneously when you use lco on claude.ai:

```
┌────────────────────────────────────────────────────────────┐
│  BROWSER TAB (claude.ai)                                   │
│                                                            │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Room 1: MAIN World                                 │   │
│  │  inject.ts                                          │   │
│  │  - Shares JS context with claude.ai page code       │   │
│  │  - Can monkey-patch window.fetch                    │   │
│  │  - Cannot use chrome.* APIs                         │   │
│  │  - Cannot import from extension lib/                │   │
│  └──────────────────┬──────────────────────────────────┘   │
│                     │ window.postMessage                   │
│  ┌──────────────────▼──────────────────────────────────┐   │
│  │  Room 2: Isolated World                             │   │
│  │  claude-ai.content.ts                               │   │
│  │  - Separate JS context from the page                │   │
│  │  - Can use chrome.* APIs                            │   │
│  │  - Can read/write the DOM                           │   │
│  │  - Validates all postMessage from Room 1            │   │
│  │  - Renders the Shadow DOM overlay                   │   │
│  └──────────────────┬──────────────────────────────────┘   │
└─────────────────────┼──────────────────────────────────────┘
                      │ chrome.runtime.sendMessage
┌─────────────────────▼──────────────────────────────────────┐
│  Room 3: Service Worker                                    │
│  background.ts                                             │
│  - No DOM, no page access                                  │
│  - Full chrome.* API access                                │
│  - Runs BPE tokenizer (js-tiktoken + claude.json)          │
│  - Writes chrome.storage.session                           │
│  - Handles tab lifecycle cleanup                           │
└────────────────────────────────────────────────────────────┘
```

**Why can't Room 1 import from lib/?**

inject.ts is bundled as an unlisted script and injected into the page's MAIN world via `injectScript()`. If it imported from `lib/`, the bundler would include any `chrome.*` references in those files. Those references throw at runtime in the MAIN world. So inject.ts is deliberately self-contained: no imports, all constants inlined, config passed via `dataset` attributes at injection time.

---

## Room 1: The fetch interceptor

inject.ts runs at `document_start`, before claude.ai's own JavaScript. It captures `window.fetch` before the page can wrap it.

```javascript
const originalFetch = window.fetch; // captured before the page touches it

window.fetch = async function (input, init) {
  const url = /* normalize string | URL | Request to string */;

  if (isCompletionEndpoint(url)) {
    const response = await originalFetch.call(this, input, init);

    if (response.body) {
      const [pageStream, monitorStream] = response.body.tee();
      decodeSSEStream(monitorStream, model, prompt);
      return new Response(pageStream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }
  }

  return originalFetch.call(this, input, init);
};
```

`.tee()` is the key. It duplicates the `ReadableStream` without consuming it. Claude's page gets `pageStream` — a byte-identical copy of the original. lco gets `monitorStream` — the same data, decoded separately.

**Endpoint detection:**

```typescript
function isCompletionEndpoint(url: string): boolean {
  // URL must contain '/chat_conversations/' AND end with '/completion'
  // (before any query string). Both conditions required.
  const idx = url.indexOf(INJECT_CONFIG.endpointSuffix);
  if (idx === -1) return false;
  const after = url[idx + INJECT_CONFIG.endpointSuffix.length];
  const terminates = after === undefined || after === '?' || after === '#';
  return url.includes(INJECT_CONFIG.endpointIncludes) && terminates;
}
```

These strings (`/chat_conversations/`, `/completion`) live in `lib/adapters/claude.ts` and are passed via `dataset.injectConfig`. New platform, new adapter, nothing in inject.ts changes.

### SSE decoding

Claude's completion endpoint returns newline-delimited Server-Sent Events:

```
data: {"type":"message_start","message":{"id":"...",...}}

data: {"type":"content_block_start","index":0,...}

data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}

data: {"type":"message_stop"}

data: [DONE]
```

inject.ts reads these with a `ReadableStreamDefaultReader`, accumulating chunks into a string buffer and splitting on newlines:

```typescript
buffer += decoder.decode(value, { stream: true });
const lines = buffer.split('\n');
buffer = lines.pop() ?? ''; // keep incomplete final line for next chunk

for (const line of lines) {
  if (!line.startsWith('data:')) continue;
  const raw = line.slice(5).trim();
  if (!raw || raw === '[DONE]') continue;
  try {
    const evt = JSON.parse(raw);
    handleProviderEvent(evt, config, health, summary, promptText);
  } catch {
    // malformed JSON — skip silently
  }
}
```

### Token estimation strategy

**During stream:** `chars / 4`. Synchronous, no latency. English text averages ~4 characters per BPE token. Code is worse. Emoji is much worse. This is a real-time approximation only.

**At stream end:** accurate BPE counts via the service worker. The full accumulated text (both prompt and response) is sent to Room 3 for encoding:

```typescript
const [inputCount, outputCount] = await Promise.all([
  countTokens(promptText),       // the actual prompt text from the request body
  countTokens(outputTextBuffer), // all text_delta chunks concatenated
]);

if (inputCount > 0) summary.inputTokens = inputCount;
if (outputCount > 0) summary.outputTokens = outputCount;
```

`countTokens` fires a `postMessage` to Room 2 (`LCO_TOKEN_REQ`), which forwards it to Room 3 as a `COUNT_TOKENS` message. Room 3 responds with the BPE count. Room 2 relays it back to Room 1 (`LCO_TOKEN_RES`). Timeout: 5 seconds; falls back to the chars/4 estimate.

### Batch flushing

inject.ts batches `TOKEN_BATCH` postMessages every 200ms instead of on every SSE event. A single fast Claude response can fire 100+ events. Sending a postMessage per event would saturate the bridge.

```typescript
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleBatchFlush() {
  if (flushTimer !== null) return; // already scheduled — idempotent
  flushTimer = setTimeout(() => {
    flushTimer = null;
    postSecureBatch({ type: 'TOKEN_BATCH', ...summary });
  }, 200);
}
```

When the stream ends, any pending flush is cancelled and a single authoritative `STREAM_COMPLETE` fires instead.

### Stream health checks

inject.ts tracks whether the stream follows the expected SSE lifecycle (`message_start` → `content_block_*` → `message_stop`). If the lifecycle breaks — due to a hung connection, proxy interference, or API changes — it posts `HEALTH_BROKEN` with a typed reason:

```typescript
type HealthBrokenReason =
  | 'missing_sentinel'      // 10+ chunks, message_start never arrived
  | 'stream_timeout'        // watchdog: 120s of silence on an active stream
  | 'incomplete_lifecycle'; // message_start arrived, message_stop never did
```

A watchdog interval checks every 10 seconds. If no bytes arrived in 120 seconds, it posts `HEALTH_BROKEN` and cancels the reader.

---

## Room 2: The content script

claude-ai.content.ts has three jobs:

1. **JIT permissions** — Claude.ai access is `optional_host_permissions`. The first visit shows a consent banner. No extension install warning.
2. **Bridge validation** — five-layer check on every postMessage from Room 1.
3. **Overlay** — renders token data in a closed Shadow DOM.

### Session token

On each page load, Room 2 generates a fresh UUID v4:

```typescript
const sessionToken = crypto.randomUUID();
```

This token is passed to Room 1 via `dataset.sessionToken`. Every postMessage from Room 1 carries it. Room 2 checks it on every message. If a page posts a message with the wrong token, it's dropped.

The token makes cross-tab message injection impossible — even if two lco-enabled tabs are open simultaneously, they use different session tokens.

### The 5-layer validator

```typescript
function isValidBridgeMessage(event: MessageEvent, sessionToken: string): boolean {
  // Layer 1: origin
  if (event.origin !== 'https://claude.ai') return false;

  // Layer 2: source (same window, not an iframe or other tab)
  if (event.source !== window) return false;

  // Layer 3: namespace
  if (!event.data || event.data.namespace !== 'LCO_V1') return false;

  // Layer 4: session token
  if (event.data.token !== sessionToken) return false;

  // Layer 5: schema — type must be known, required fields must be present and correctly typed
  return isValidBridgeSchema(event.data);
}
```

This is not theoretical. Content scripts are accessible to the page in various ways, and extension bugs have historically allowed page JS to trigger privileged code paths. Five layers is the answer.

### Shadow DOM overlay

The overlay renders inside a closed Shadow DOM:

```typescript
const shadow = overlayContainer.attachShadow({ mode: 'closed' });
```

`mode: 'closed'` means `element.shadowRoot` returns null from page JavaScript. Claude's styles and scripts cannot reach the overlay elements. The overlay's styles cannot leak into the page.

It's built with vanilla DOM — no React, no framework. WXT silently strips React from content scripts at `document_start`. Vanilla DOM is the right choice here.

---

## Room 3: The service worker

background.ts handles token counting, storage, and tab lifecycle.

### BPE tokenizer

```typescript
import { Tiktoken } from 'js-tiktoken/lite';
import claudeJson from '@anthropic-ai/tokenizer/claude.json';

const tokenizer = new Tiktoken({
  bpe_ranks: claudeJson.bpe_ranks,
  special_tokens: claudeJson.special_tokens,
  pat_str: claudeJson.pat_str,
});
```

`claudeJson` is Anthropic's actual BPE vocabulary — the same one Claude uses. `js-tiktoken/lite` is the pure-JS implementation (no WASM), which works in the service worker context without additional CSP entries.

The tokenizer is initialized at worker startup, before any messages arrive. MV3 service workers sleep aggressively; the preload pattern means the tokenizer is warm when the first message arrives, but a sleep-and-wake cycle may require reinitializing. Cold start: ~20-40ms.

### Storage

Per-tab state lives in `chrome.storage.session` under predictable keys:

```
tabState_{tabId}    → current request: model, tokens, cost, stopReason
sessionCost_{tabId} → running totals: totalInputTokens, totalOutputTokens, requestCount, estimatedCost
```

Session totals accumulate only on `STREAM_COMPLETE` (`stopReason !== null`), not on every `TOKEN_BATCH` intermediate flush. This prevents double-counting.

Tab cleanup fires on `browser.tabs.onRemoved`. A periodic alarm (`cleanOrphanedTabs`, every 5 minutes) removes storage keys for tabs that were closed while the service worker was sleeping.

### Platform attribution

```typescript
// background.ts
const platform =
  sender.url?.includes('claude.ai')
    ? 'claude'
    : sender.url?.includes('chat.openai.com')
      ? 'chatgpt'
      : message.platform;
```

`sender.url` is set by Chrome and cannot be spoofed by the page. Even if a malicious page sends a message claiming `platform: 'claude'`, the service worker uses the actual sender URL for attribution.

---

## Provider abstraction

Adding a new platform requires a new adapter file. The adapter defines everything platform-specific:

```typescript
// lib/adapters/types.ts
interface InjectConfig {
  endpointIncludes: string;     // URL substring to match
  endpointSuffix: string;       // URL suffix to match
  events: {
    streamStart: string;        // SSE event type that fires first
    contentBlockStart: string;  // signals output is starting
    contentDelta: string;       // carries text chunks
    streamEnd: string;          // signals stream is done
    messageLimit: string;       // usage cap data
    stopReason: string;         // contains stop_reason field
  };
  paths: {
    messageLimitUtilization: string; // dot-path to utilization value
    stopReason: string;              // dot-path to stop_reason value
    contentDeltaType: string;        // dot-path to delta type field
    contentDeltaTypeValue: string;   // expected value for text deltas
    contentDeltaText: string;        // dot-path to text content
  };
  body: {
    model: string;   // request body field name for model
    prompt: string;  // request body field name for prompt
  };
}
```

The content script serializes the adapter's `injectConfig` into `dataset.injectConfig` before injecting Room 1. Room 1 reads it at runtime. Room 1 never changes when a new platform is added.

---

## Data flow: a single message, traced

1. User sends a message in claude.ai
2. Claude's frontend calls `window.fetch('/api/.../completion', { body: '{"model":"claude-sonnet-4-6","prompt":"..."}' })`
3. lco's patched `window.fetch` intercepts this in Room 1
4. Room 1 calls the original fetch, gets the response
5. Room 1 tees the response body
6. Room 1 starts decoding `monitorStream` asynchronously
7. Every 200ms, Room 1 posts a `TOKEN_BATCH` message: `{ namespace: 'LCO_V1', token: sessionToken, type: 'TOKEN_BATCH', inputTokens: 50, outputTokens: 200, model: 'claude-sonnet-4-6' }`
8. Room 2 receives it, validates all 5 layers, passes
9. Room 2 sends `STORE_TOKEN_BATCH` to Room 3 via `chrome.runtime.sendMessage`
10. Room 3 writes updated `tabState` and `sessionCost` to `chrome.storage.session`
11. Room 3 responds with the written state
12. Room 2 updates the overlay with the authoritative values from storage
13. Stream ends. Room 1 sends full accumulated text to Room 2 for BPE counting (via `LCO_TOKEN_REQ` postMessage)
14. Room 2 forwards to Room 3 as `COUNT_TOKENS`
15. Room 3 encodes with BPE tokenizer, responds
16. Room 2 relays count back to Room 1 (via `LCO_TOKEN_RES` postMessage)
17. Room 1 fires final `STREAM_COMPLETE` with accurate BPE counts
18. Room 2 validates, sends to Room 3 with `stopReason !== null`
19. Room 3 accumulates session cost totals, responds
20. Room 2 updates the overlay with final accurate values

Claude's page gets `pageStream` throughout this process — an identical byte stream, undisturbed.

---

## What we haven't solved

**Per-conversation context, not per-request.** We see what each API call sends. Claude maintains conversation history server-side. On long conversations, Claude may summarize older turns — we can't measure that. Our context percentage reflects what was in this API request, not the full conversation history Claude is tracking.

**The chars/4 gap.** The real-time display is approximate. There's a visible jump when the accurate BPE count lands at stream end. We haven't found a faster approach that maintains accuracy. BPE encoding mid-stream would require sending partial text to the service worker on every delta — latency is acceptable, but the output count would be wrong until the next BPE call.

**Service worker sleeping.** MV3 service workers sleep after inactivity. The tokenizer must re-initialize after a sleep. We preload at startup, but a sleep-wake cycle adds latency on the first request after a period of inactivity. We don't have a clean fix that doesn't abuse keepalive mechanisms.

**Extension update invalidation.** When the extension updates, existing content scripts keep running but lose their connection to the new service worker. This causes a silent failure where the overlay stops updating. The user has to reload the tab. We know. Chrome doesn't provide a clean fix.
