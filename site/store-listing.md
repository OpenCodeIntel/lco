# Chrome Web Store Listing: Saar

Reference file for the CWS developer dashboard submission.

---

## Name

Saar

## Short description (132 chars max)

See token count, cost, and context usage live on claude.ai. All counting happens locally. No data ever leaves your browser.

## Full description

Claude strips token counts from its web UI. Every request fires an SSE stream containing your token usage, stop reasons, and context data. Claude's interface discards all of it before you ever see it.

Saar intercepts that stream before the data disappears, counts tokens locally using Anthropic's own BPE vocabulary, and renders what you're spending in a live overlay directly on claude.ai.

**What you see:**
- Token count and estimated cost for every reply, updated live as Claude streams
- Running session total across all conversations in the same tab
- Context window utilization (Opus 4.7: 1M; Sonnet 4.6: 1M on claude.ai Free and Pro plans; Haiku 4.5: 200K)
- Message limit utilization when applicable
- Smart nudges when context is filling up: warnings at 60%, 75%, and 90%

**How it works:**
Saar intercepts the fetch stream on claude.ai using a secure, sandboxed injected script. Token counting runs entirely inside your browser using a bundled BPE tokenizer: the same vocabulary Anthropic uses. No text, no messages, no personal data ever leaves your machine.

**Privacy:**
- Zero data collection. No analytics, no telemetry, no servers.
- All session data is stored in chrome.storage.session and cleared when your browser closes.
- The content of your conversations is never read or stored.
- Fully open source: github.com/OpenCodeIntel/lco

**Permissions:**
- claude.ai access is optional and requested at runtime. The extension does nothing until you explicitly enable it.
- storage, tabs, scripting, alarms, unlimitedStorage, and sidePanel are used solely for local token counting, session cleanup, and the side panel UI.

---

## Category

Productivity

## Language

English

## Privacy policy URL

https://getsaar.com/privacy

## Homepage URL

https://getsaar.com

---

## Review justification notes
(paste into the "Notes for reviewers" field in the CWS dashboard)

This extension intercepts the SSE stream on claude.ai to read token usage
data that Claude's web UI discards. Specifically:

1. A sandboxed IIFE script is injected via chrome.scripting at document_start
   to wrap window.fetch and tee the response stream. The tee is read-only;
   the original stream is passed through to claude.ai unmodified.

2. The injected script communicates with the extension's content script via
   postMessage with a 5-layer security model: origin check, source check,
   namespace (LCO_V1), per-session UUID token, and schema validation. All
   five layers must pass or the message is dropped.

3. Token counting uses js-tiktoken with Anthropic's published claude.json BPE
   vocabulary, bundled inside the extension. No network requests are made for
   tokenization.

4. Session data (token counts, costs) is stored in chrome.storage.session,
   scoped by tabId, and automatically cleared when the browser closes.

5. The host permission for https://claude.ai/* is optional
   (optional_host_permissions) and requested at runtime via JIT prompt.
   The extension is inert until the user explicitly grants access.

No user content (message text, conversation history) is read or stored.
Source code: https://github.com/OpenCodeIntel/lco

---

## Screenshots (1280x800 — save to docs/cws-assets/)

1. `docs/cws-assets/screenshot-1-overlay.png`: overlay mid-conversation showing live token count and cost
2. `docs/cws-assets/screenshot-2-threshold.png`: context bar near warning threshold (amber nudge visible)
3. `docs/cws-assets/screenshot-3-session-totals.png`: session totals after multiple requests

## Icons

Already in repo: icon/16.png, icon/32.png, icon/48.png, icon/96.png, icon/128.png
