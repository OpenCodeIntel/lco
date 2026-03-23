// entrypoints/claude-ai.content.ts - Content script for claude.ai (Room 2)
// Executes within the extension's isolated world, alongside the host page.
// Responsibilities:
// 1. Generate a per-session security token and inject the main-world interceptor.
// 2. Act as a 5-layer-validated cross-world message bridge for token data.
// 3. Forward validated token batches to the background service worker for storage.

import type { LcoBridgeMessage, StoreTokenBatchMessage } from '../lib/message-types';
import { LCO_NAMESPACE } from '../lib/message-types';

export default defineContentScript({
    matches: ['https://claude.ai/*'],
    runAt: 'document_start', // Must execute before any host page scripts load
    async main() {
        console.log('[LCO] Content script initialized on claude.ai');

        // Generate a unique session token for this page load.
        // This token is embedded into every bridge message from the MAIN world
        // and validated here before forwarding to the background worker.
        const sessionToken = crypto.randomUUID();

        // Persist the token in session storage so the background worker
        // can validate it if needed in future security expansions.
        await browser.storage.session.set({
            [`sessionToken_${location.hostname}`]: sessionToken,
        });

        // Inject the main-world fetch interceptor, passing the session token
        // and platform identifier via safe dataset attributes on the script tag.
        await injectScript('/inject.js', {
            keepInDom: true, // Retain tag for dataset attribute access in MAIN world
            modifyScript(script) {
                script.dataset.sessionToken = sessionToken;
                script.dataset.platform = 'claude';
            },
        });

        console.log('[LCO] Main-world interceptor successfully injected.');

        // 5-Layer Message Bridge: Main World (inject.js) -> Service Worker (background.ts)
        window.addEventListener('message', (event) => {
            // Layer 1: Strict origin check — reject messages from any other domain
            if (event.origin !== window.location.origin) return;

            // Layer 2: Source may be null for Chrome-internal messages — do NOT reject on null.
            // The origin check above is our primary defense.

            // Layer 3: Namespace isolation — only process LCO_V1 messages
            if (!event.data || event.data.namespace !== LCO_NAMESPACE) return;

            // Layer 4: Session token authentication — one token per page load
            if (event.data.token !== sessionToken) return;

            // Layer 5: Schema validation — must have a valid message type
            if (!isValidBridgeSchema(event.data)) return;

            const msg = event.data as LcoBridgeMessage;

            // Only TOKEN_BATCH and STREAM_COMPLETE carry data we need to store
            if (msg.type === 'TOKEN_BATCH' || msg.type === 'STREAM_COMPLETE') {
                const storageMessage: StoreTokenBatchMessage = {
                    type: 'STORE_TOKEN_BATCH',
                    platform: msg.platform,
                    model: msg.model ?? 'unknown',
                    inputTokens: msg.inputTokens ?? 0,
                    outputTokens: msg.outputTokens ?? 0,
                    stopReason: msg.type === 'STREAM_COMPLETE' ? (msg.stopReason ?? null) : null,
                };
                browser.runtime.sendMessage(storageMessage).catch((err) => {
                    console.error('[LCO-ERROR] Failed to forward token batch to background:', err);
                });
            }

            if (msg.type === 'HEALTH_BROKEN') {
                console.warn('[LCO] Health check broken signal received from MAIN world:', msg.message);
            }

            if (msg.type === 'MESSAGE_LIMIT_UPDATE') {
                browser.runtime.sendMessage({
                    type: 'STORE_MESSAGE_LIMIT',
                    platform: msg.platform,
                    messageLimitUtilization: msg.messageLimitUtilization,
                }).catch((err) => {
                    console.error('[LCO-ERROR] Failed to forward message limit to background:', err);
                });
            }
        });

        // Internal token counting bridge messages (BPE requests from inject.ts)
        // These use a separate, simpler message type and are forwarded directly.
        window.addEventListener('message', (event) => {
            if (event.source !== window || !event.data || event.data.type !== 'LCO_TOKEN_REQ') return;

            const { id, text } = event.data;

            browser.runtime.sendMessage({ type: 'COUNT_TOKENS', text })
                .then((response: any) => {
                    const count = response?.count ?? 0;
                    window.postMessage({ type: 'LCO_TOKEN_RES', id, count }, window.location.origin);
                })
                .catch((err: any) => {
                    console.error('[LCO-ERROR] Content script BPE bridge transmission failed:', err);
                    window.postMessage({ type: 'LCO_TOKEN_RES', id, count: 0 }, window.location.origin);
                });
        });
    },
});

/**
 * Layer 5 schema validator — confirms the incoming message has all required
 * fields before we forward it to the service worker. Prevents malformed or
 * adversarially crafted payloads from reaching storage.
 */
function isValidBridgeSchema(data: any): boolean {
    if (typeof data !== 'object' || data === null) return false;
    if (data.namespace !== LCO_NAMESPACE) return false;
    if (typeof data.token !== 'string' || data.token.length === 0) return false;
    if (!['TOKEN_BATCH', 'STREAM_COMPLETE', 'HEALTH_BROKEN', 'MESSAGE_LIMIT_UPDATE'].includes(data.type)) return false;
    if (data.type === 'MESSAGE_LIMIT_UPDATE') {
        if (typeof data.messageLimitUtilization !== 'number') return false;
    } else if (data.type !== 'HEALTH_BROKEN') {
        if (typeof data.inputTokens !== 'number') return false;
        if (typeof data.outputTokens !== 'number') return false;
        if (typeof data.model !== 'string') return false;
    }
    return true;
}
