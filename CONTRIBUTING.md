# Contributing to lco

lco started as a frustration project — a Master's student watching Claude bills climb with no way to see where the money was going. If you've felt that, you're the target contributor.

This is a small, focused codebase. The core problem (intercept SSE stream → count tokens → show cost) is solved. What's left is making it better, faster, and honest about what it doesn't know yet.

---

## What we actually need help with

### 1. More platform adapters

The architecture (`lib/adapters/`) is designed for this. Adding a new provider means:

- One adapter file (`lib/adapters/chatgpt.ts`) with the SSE event names and data paths
- One content script entry (`entrypoints/chatgpt.content.ts`) that registers the adapter and injects the interceptor
- Pricing entries in `assets/pricing.json`
- A new `matches` entry in `wxt.config.ts`

**What's hard:** every platform structures their SSE events differently. ChatGPT uses `delta.content` for text. Claude uses `delta.text` inside a `content_block_delta` event. You have to inspect the actual stream to find the right paths.

To inspect a platform's stream:

```javascript
// Paste in browser console on the target platform:
const orig = window.fetch;
window.fetch = async (...args) => {
  const res = await orig(...args);
  if (res.body && args[0].toString().includes('your-endpoint-pattern')) {
    const [a, b] = res.body.tee();
    const reader = b.getReader();
    (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        console.log(new TextDecoder().decode(value));
      }
    })();
    return new Response(a, res);
  }
  return res;
};
```

### 2. Context intelligence

lco currently reports. It does not advise. The next step is detecting patterns that actually cost users money:

- Conversation length thresholds where starting fresh would be cheaper
- Repeated context (pasting the same file multiple times)
- Models being used for tasks that don't need them (Opus for a one-liner)

This logic belongs in `lib/` as pure functions with no DOM or Chrome API references.

### 3. Test coverage

The SSE decode path, health check state machine, and batch flush debounce are tested. The overlay rendering and the full end-to-end flow (real extension, real page) are not. Manual testing is the current process for anything involving the browser runtime.

### 4. Pricing data

`assets/pricing.json` is hand-maintained. Anthropic changes pricing. If a model is missing or a price is wrong, a PR to `assets/pricing.json` with a source link is a legitimate and useful contribution.

---

## Architecture you need to understand before touching anything

Three isolated JavaScript execution contexts. Data flows one-way. Violating this breaks things.

```
Room 1: MAIN World (inject.ts)
  - Runs inside the page's JavaScript context
  - Can read window.fetch, window.postMessage
  - Cannot use chrome.* APIs
  - Cannot import from lib/ (would bundle chrome.* refs)
  - All config passed via document.currentScript.dataset at injection time

Room 2: Content Script (claude-ai.content.ts)
  - Runs in the extension's isolated world
  - Can read the DOM, but separately from the page
  - Can use chrome.* APIs
  - Validates every postMessage from Room 1 (5 layers)
  - Renders the overlay

Room 3: Service Worker (background.ts)
  - No DOM access
  - Full chrome.* access
  - Runs the BPE tokenizer
  - Writes chrome.storage.session
  - Handles tab cleanup
```

**The rule that trips everyone up:** `inject.ts` cannot import anything. Not from `lib/`, not from `node_modules`. It runs in the page's main world. If it imported from `lib/`, the bundler would include `chrome.*` references that break in that context. Every constant is inlined. Every config is passed via `dataset` attributes at injection time.

The content script serializes the provider config before injecting:

```typescript
// claude-ai.content.ts
import { ClaudeAdapter } from '../lib/adapters/claude';

scriptEl.dataset.sessionToken = sessionToken;    // fresh UUID per page load
scriptEl.dataset.platform = ClaudeAdapter.name;
scriptEl.dataset.injectConfig = JSON.stringify(ClaudeAdapter.injectConfig);
```

Then inject.ts reads it:

```typescript
// inject.ts — no imports, all runtime reads
const SESSION_TOKEN = document.currentScript?.dataset.sessionToken ?? '';
const INJECT_CONFIG = JSON.parse(document.currentScript?.dataset.injectConfig ?? '{}');
```

---

## Development setup

**Requirements:** Node 20+, Bun, Chrome

```bash
git clone https://github.com/OpenCodeIntel/lco
cd lco
bun install
bun run dev   # starts WXT with hot reload
```

Load the extension once:

1. `chrome://extensions` → Developer mode on
2. Load unpacked → `.output/chrome-mv3`
3. Open `claude.ai`, click Enable in the banner

After that, source changes reload automatically.

**Run tests:**

```bash
bun run test       # unit + integration tests
bun run compile    # TypeScript check (no emit)
bun run build      # production build
```

All three must be clean before opening a PR. If `bun run compile` shows errors, fix them. If `bun run test` fails, fix that first.

**Coverage:**

```bash
bun run coverage   # outputs to stdout + coverage/
```

---

## File structure

```
entrypoints/
  inject.ts              # Room 1: fetch interceptor + SSE decoder
  claude-ai.content.ts   # Room 2: bridge validation + overlay
  background.ts          # Room 3: tokenizer + storage

lib/
  message-types.ts       # All cross-room message interfaces (single source of truth)
  pricing.ts             # Model lookup + cost calculation
  platform-config.ts     # Provider adapter registry
  adapters/
    types.ts             # InjectConfig + ProviderAdapter interfaces
    claude.ts            # Claude-specific SSE event names, paths, endpoint patterns

assets/
  pricing.json           # Model pricing data

ui/
  overlay-styles.ts      # Shadow DOM CSS for the overlay

tests/
  unit/                  # Pure logic tests (no browser runtime)
  integration/           # IPC pipeline tests (simulated bridge)
```

---

## What's messy

**The overlay is one big file.** `claude-ai.content.ts` handles JIT permissions, session token generation, script injection, bridge validation, storage forwarding, and overlay rendering — all 575 lines of it. It works, but it's headed toward needing a split. If you're refactoring, coordinate first.

**The chars/4 estimate.** During streaming, token counts are approximate (`text.length / 4`). This is fast and synchronous. The BPE-accurate count fires at stream end. The gap between them is visible — the number updates when the stream finishes. We know. We haven't found a better real-time approach that doesn't block the stream.

**The tokenizer cold start.** First BPE count after the service worker boots takes ~20-40ms. The service worker preloads it at startup, but MV3 service workers sleep aggressively. If the worker was sleeping when the first message arrives, the user may see the chars/4 estimate persist slightly longer than expected before the accurate count lands.

**Context % is incomplete.** We see what each API call sends — input tokens and output tokens. We do not see Claude's internal context assembly. If Claude summarizes earlier parts of a long conversation, our context percentage may undercount. We don't have a fix for this yet.

---

## PR process

1. Fork the repo
2. Branch off `main`:
   ```bash
   git checkout -b feat/lco-XX-short-description
   ```
3. Make changes. One thing per PR.
4. Before pushing:
   ```bash
   bun run test && bun run compile && bun run build
   ```
5. Open a PR against `main` on the upstream repo (`OpenCodeIntel/lco`)

**Commit format:**

```
type(scope): description [LCO-XX]
```

```
feat(adapters): add ChatGPT provider adapter [LCO-22]
fix(inject): handle URL object in fetch overload [LCO-31]
test(health): add watchdog timeout edge cases [LCO-16]
docs(readme): fix install steps
```

Types: `feat`, `fix`, `test`, `docs`, `refactor`, `chore`. No emojis. No "Co-Authored-By" lines.

---

## What we're still figuring out

- How to get accurate conversation-level context (not just per-request)
- Whether to persist session data across browser restarts (and what that means for privacy)
- The right abstractions for context intelligence — we don't want to ship rules that feel like guessing
- How to test the overlay rendering without a real browser (currently manual)
- Whether the BPE tokenizer is accurate enough for cost estimates to be trusted to the cent, or just to the dollar

If you have ideas on any of these, open an issue. We'd rather talk before someone builds the wrong thing.
