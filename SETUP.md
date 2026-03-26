# Setup

## Prerequisites

- **Node 20+** — check with `node --version`
- **Bun** — install from [bun.sh](https://bun.sh) if you don't have it: `curl -fsSL https://bun.sh/install | bash`
- **Chrome** or a Chromium-based browser (Arc, Brave, Edge)
- A claude.ai account (free or paid — the extension works with both)

---

## Installation

```bash
git clone https://github.com/OpenCodeIntel/lco
cd lco
bun install
bun run build
```

If `bun run build` completes without errors, you'll see `.output/chrome-mv3/` in the project root. That's the built extension.

**Load it in Chrome:**

1. Open `chrome://extensions` in a new tab
2. Toggle **Developer mode** on (top-right corner)
3. Click **Load unpacked**
4. Select the `.output/chrome-mv3` folder
5. The LCO extension appears in your extensions list

---

## First run

1. Open a new tab and navigate to `claude.ai`
2. A small banner appears in the bottom-right corner:

   ```
   LCO — Enable token tracking for Claude?   [Enable]  [Dismiss]
   ```

3. Click **Enable**
4. The banner disappears and the overlay appears
5. Send a message to Claude — the overlay updates in real time

If you don't see the banner, check that the extension is enabled in `chrome://extensions` and that it shows no errors.

---

## Development setup

```bash
bun run dev
```

This starts WXT's development server with hot module replacement. The extension in Chrome reloads automatically when you save files.

You only need to load the extension once (`.output/chrome-mv3`). After that, `bun run dev` keeps it updated.

**Workflow:**

```bash
# Terminal 1: watch mode
bun run dev

# Terminal 2: tests and type checking as you work
bun run test:watch
bun run compile      # run manually when types might be off
```

---

## Verification

To confirm lco is working correctly:

1. Send a message to Claude
2. Watch the overlay in the bottom-right corner during the response
3. Token counts update every 200ms while Claude responds
4. When the response finishes, the counts update once more with accurate BPE values
5. Open Chrome DevTools → Console, filter by `[LCO]` — you should see:

   ```
   [LCO] Fetch interceptor initialized successfully.
   [LCO] Intercepted completion request: ...
   [LCO] message_start : input: ~143 tokens (chars/4 estimate)
   [LCO] message_stop : stream confirmed complete
   [LCO] [Complete] model: claude-sonnet-4-6 | ~247 in | ~89 out | stop: end_turn
   ```

6. The service worker logs (in `chrome://extensions` → LCO → Service Worker → Inspect):

   ```
   [LCO] Service worker booted; pure-JS tokenizer preloading in background.
   [LCO] Tokenizer cold start: 23ms
   ```

If these logs appear, everything is working.

---

## Running tests

```bash
bun run test          # run all tests once
bun run test:watch    # watch mode
bun run coverage      # with coverage report
```

Tests run in Node — no browser required. The test suite covers the SSE parsing logic, bridge security, health state machine, batch flush debounce, pricing, and tab storage.

TypeScript check (no build output):

```bash
bun run compile
```

This must be clean before any PR.

---

## Common issues

### The banner doesn't appear

The extension needs `optional_host_permissions` for `claude.ai`. This is granted when you click Enable in the banner. If you dismissed the banner without enabling:

1. Go to `chrome://extensions`
2. Find LCO → click **Details**
3. Under "Site access", set `claude.ai` to "Allow"

Or remove the extension and reload the page to see the banner again.

### The overlay appears but doesn't update

Check the DevTools console for `[LCO-ERROR]` messages. Common cause: the service worker is sleeping. Send another message to wake it — the second request should work.

If the service worker keeps failing, check `chrome://extensions` → LCO → Service Worker → Inspect for errors.

### `bun run build` fails with TypeScript errors

```bash
bun run compile  # see the exact errors
```

Fix them, then rebuild. The most common cause is a type mismatch after pulling new changes.

### Extension stops updating after a while

This is the MV3 service worker sleep issue. The extension loses its connection to the service worker after inactivity. Reload the tab to restore the connection. This is a known Chrome limitation.

### Token counts seem off

During streaming, counts use `chars / 4` — a rough approximation. The accurate BPE count lands when the stream ends. If the final count looks wrong (far from what you'd expect), open an issue with the model name and a rough estimate of the prompt/response length.

---

## Building for distribution

```bash
bun run zip
```

This produces a `.zip` in `.output/` suitable for Chrome Web Store submission. The Chrome Web Store release is not yet live — see the README for current status.
