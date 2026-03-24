// entrypoints/claude-ai.content.ts - Content script for claude.ai (Room 2)
// Executes within the extension's isolated world, alongside the host page.
// Responsibilities:
// 1. Generate a per-session security token and inject the main-world interceptor.
// 2. Act as a 5-layer-validated cross-world message bridge for token data.
// 3. Forward validated token batches to the background service worker for storage.
// 4. Render the shadow DOM token overlay and keep it in sync with stream events.

import type { LcoBridgeMessage, StoreTokenBatchMessage, StoreTokenBatchResponse } from '../lib/message-types';
import { LCO_NAMESPACE } from '../lib/message-types';
import { calculateCost, getContextWindowSize } from '../lib/pricing';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import TokenOverlay, { type OverlayProps } from '../ui/TokenOverlay';
import { OVERLAY_CSS } from '../ui/overlay-styles';

export default defineContentScript({
    matches: ['https://claude.ai/*'],
    runAt: 'document_start', // Must execute before any host page scripts load
    async main() {
        // Skip iframes — inject.ts only runs in the top-level frame, so only
        // the top-level content script can receive TOKEN_BATCH messages.
        if (window !== window.top) return;

        console.log('[LCO] Content script initialized on claude.ai');

        // Generate a unique session token for this page load.
        // This token is embedded into every bridge message from the MAIN world
        // and validated here before forwarding to the background worker.
        const sessionToken = crypto.randomUUID();

        // --- Overlay state ---
        // Declared before any async work so message listeners below can close over it
        // and update it even if they fire before the shadow DOM is ready.
        let overlayRoot: Root | null = null;

        let overlayProps: OverlayProps = {
            lastRequest: null,
            session: { requestCount: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCost: null },
            messageLimitUtilization: null,
            contextPct: null,
            healthBroken: null,
        };

        // renderOverlay is a no-op until overlayRoot is initialised. Any updates that
        // arrive before the shadow DOM is ready are stored in overlayProps and flushed
        // on the first render after setup completes.
        function renderOverlay() {
            overlayRoot?.render(createElement(TokenOverlay, overlayProps));
        }

        // --- 5-Layer Message Bridge: Main World (inject.js) -> Service Worker ---
        // Registered synchronously, before any await, so no TOKEN_BATCH or
        // STREAM_COMPLETE events can be dropped during async shadow DOM setup.
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

            if (msg.type === 'TOKEN_BATCH') {
                // Fast path: update overlay immediately with streaming estimates (chars/4).
                // Fire-and-forget to background — we don't need the response here.
                const storageMessage: StoreTokenBatchMessage = {
                    type: 'STORE_TOKEN_BATCH',
                    platform: msg.platform,
                    model: msg.model ?? 'unknown',
                    inputTokens: msg.inputTokens ?? 0,
                    outputTokens: msg.outputTokens ?? 0,
                    stopReason: null,
                };
                browser.runtime.sendMessage(storageMessage).catch((err) => {
                    console.error('[LCO-ERROR] Failed to forward TOKEN_BATCH to background:', err);
                });

                overlayProps = {
                    ...overlayProps,
                    lastRequest: {
                        inputTokens: msg.inputTokens,
                        outputTokens: msg.outputTokens,
                        model: msg.model,
                        cost: calculateCost(msg.inputTokens, msg.outputTokens, msg.model),
                    },
                };
                renderOverlay();
            }

            if (msg.type === 'STREAM_COMPLETE') {
                // Show an immediate estimate first, then overwrite with the authoritative
                // data returned by the background after it has written to storage.
                overlayProps = {
                    ...overlayProps,
                    lastRequest: {
                        inputTokens: msg.inputTokens,
                        outputTokens: msg.outputTokens,
                        model: msg.model,
                        cost: calculateCost(msg.inputTokens, msg.outputTokens, msg.model),
                    },
                };
                renderOverlay();

                const storageMessage: StoreTokenBatchMessage = {
                    type: 'STORE_TOKEN_BATCH',
                    platform: msg.platform,
                    model: msg.model ?? 'unknown',
                    inputTokens: msg.inputTokens ?? 0,
                    outputTokens: msg.outputTokens ?? 0,
                    stopReason: msg.stopReason ?? null,
                };
                browser.runtime.sendMessage(storageMessage)
                    .then((response: StoreTokenBatchResponse) => {
                        if (!response?.ok || !response.tabState || !response.sessionCost) return;
                        const { tabState, sessionCost } = response;
                        const contextPct =
                            (tabState.inputTokens + tabState.outputTokens) /
                            getContextWindowSize(tabState.model) * 100;
                        overlayProps = {
                            ...overlayProps,
                            lastRequest: {
                                inputTokens: tabState.inputTokens,
                                outputTokens: tabState.outputTokens,
                                model: tabState.model,
                                cost: calculateCost(tabState.inputTokens, tabState.outputTokens, tabState.model),
                            },
                            session: {
                                requestCount: sessionCost.requestCount,
                                totalInputTokens: sessionCost.totalInputTokens,
                                totalOutputTokens: sessionCost.totalOutputTokens,
                                totalCost: sessionCost.estimatedCost ?? null,
                            },
                            messageLimitUtilization: tabState.messageLimitUtilization ?? overlayProps.messageLimitUtilization,
                            contextPct,
                        };
                        renderOverlay();
                    })
                    .catch((err) => {
                        console.error('[LCO-ERROR] Failed to forward STREAM_COMPLETE to background:', err);
                    });
            }

            if (msg.type === 'HEALTH_BROKEN') {
                console.warn('[LCO] Health check broken signal received from MAIN world:', msg.message);
                overlayProps = { ...overlayProps, healthBroken: msg.message };
                renderOverlay();
            }

            if (msg.type === 'MESSAGE_LIMIT_UPDATE') {
                browser.runtime.sendMessage({
                    type: 'STORE_MESSAGE_LIMIT',
                    platform: msg.platform,
                    messageLimitUtilization: msg.messageLimitUtilization,
                }).catch((err) => {
                    console.error('[LCO-ERROR] Failed to forward message limit to background:', err);
                });
                overlayProps = { ...overlayProps, messageLimitUtilization: msg.messageLimitUtilization };
                renderOverlay();
            }
        });

        // Internal token counting bridge (BPE requests from inject.ts → background)
        window.addEventListener('message', (event) => {
            if (event.source !== window || !event.data || event.data.type !== 'LCO_TOKEN_REQ') return;

            const { id, text } = event.data;

            browser.runtime.sendMessage({ type: 'COUNT_TOKENS', text })
                .then((response: any) => {
                    const count = typeof response?.count === 'number' ? response.count : 0;
                    window.postMessage({ type: 'LCO_TOKEN_RES', id, count }, window.location.origin);
                })
                .catch((err: any) => {
                    console.error('[LCO-ERROR] Content script BPE bridge transmission failed:', err);
                    window.postMessage({ type: 'LCO_TOKEN_RES', id, count: 0 }, window.location.origin);
                });
        });

        // --- Async setup (does not block message handling above) ---

        // Persist the session token so the background can validate it in future expansions.
        browser.storage.session.set({
            [`sessionToken_${location.hostname}`]: sessionToken,
        }).catch(() => { /* non-critical */ });

        // Inject the main-world fetch interceptor.
        await injectScript('/inject.js', {
            keepInDom: true, // Retain tag for dataset attribute access in MAIN world
            modifyScript(script) {
                script.dataset.sessionToken = sessionToken;
                script.dataset.platform = 'claude';
            },
        });

        console.log('[LCO] Main-world interceptor successfully injected.');

        // --- Shadow DOM Overlay ---

        try {
            console.log('[LCO] Waiting for document.body...');

            // Wait for body — document_start fires before <body> is parsed.
            // Guards against both cases: body not yet present, and DOMContentLoaded
            // already fired before we registered the listener.
            if (!document.body) {
                await new Promise<void>(resolve => {
                    if (document.readyState !== 'loading') {
                        resolve();
                    } else {
                        document.addEventListener('DOMContentLoaded', () => resolve(), { once: true });
                    }
                });
            }

            console.log('[LCO] document.body available');

            const host = document.createElement('div');
            host.id = 'lco-widget-host';
            // Append to <html> (sibling of <body>), not to <body> itself.
            // Next.js hydrates <body> and wipes foreign children injected before it runs.
            // document.documentElement is outside React's managed tree and survives SPA hydration.
            document.documentElement.appendChild(host);

            console.log('[LCO] Host element created');

            // Closed shadow root: prevents page CSS from leaking in or out.
            const shadow = host.attachShadow({ mode: 'closed' });

            console.log('[LCO] Shadow root attached');

            const style = document.createElement('style');
            style.textContent = OVERLAY_CSS;
            shadow.appendChild(style);

            const container = document.createElement('div');
            shadow.appendChild(container);

            overlayRoot = createRoot(container);

            console.log('[LCO] React root created');

            // Render immediately — overlayProps may already contain data if STREAM_COMPLETE
            // arrived during the async setup window above.
            renderOverlay();

            console.log('[LCO] Overlay shadow DOM mounted.');

            // Reset overlay state on SPA navigation (Navigation API, Chrome 102+)
            if ('navigation' in window) {
                (window as any).navigation.addEventListener('navigatesuccess', () => {
                    overlayProps = {
                        lastRequest: null,
                        session: { requestCount: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCost: null },
                        messageLimitUtilization: null,
                        contextPct: null,
                        healthBroken: null,
                    };
                    renderOverlay();
                });
            }
        } catch (err) {
            console.error('[LCO-ERROR] Overlay mount failed:', err);
        }
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
    } else if (data.type === 'HEALTH_BROKEN') {
        if (typeof data.message !== 'string') return false;
    } else {
        if (typeof data.inputTokens !== 'number') return false;
        if (typeof data.outputTokens !== 'number') return false;
        if (typeof data.model !== 'string') return false;
    }
    return true;
}
