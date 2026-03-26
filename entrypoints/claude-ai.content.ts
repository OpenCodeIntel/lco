// entrypoints/claude-ai.content.ts - Content script for claude.ai (Room 2)
// Executes within the extension's isolated world, alongside the host page.
// Responsibilities:
// 1. JIT permission gate — shows an enable banner on first visit, zero install warnings.
// 2. Generate a per-session security token and inject the main-world interceptor.
// 3. Act as a 5-layer-validated cross-world message bridge for token data.
// 4. Forward validated token batches to the background service worker for storage.
// 5. Render the shadow DOM token overlay via vanilla DOM (no React dependency).

import type { LcoBridgeMessage, StoreTokenBatchMessage, StoreTokenBatchResponse } from '../lib/message-types';
import { LCO_NAMESPACE } from '../lib/message-types';
import { calculateCost, getContextWindowSize } from '../lib/pricing';
import { OVERLAY_CSS } from '../ui/overlay-styles';
import { ClaudeAdapter } from '../lib/adapters/claude';

export default defineContentScript({
    matches: ['https://claude.ai/*'],
    runAt: 'document_start',
    async main() {
        // Skip iframes — inject.ts only runs in the top-level frame.
        if (window !== window.top) return;

        const stored = await browser.storage.local.get('lco_enabled_claude');
        if (stored.lco_enabled_claude) {
            await initializeMonitoring();
        } else {
            await showEnableBanner();
        }
    },
});

// ---------------------------------------------------------------------------
// JIT Permission Banner
// ---------------------------------------------------------------------------

async function showEnableBanner(): Promise<void> {
    if (!document.body) {
        await new Promise<void>(resolve => {
            if (document.readyState !== 'loading') resolve();
            else document.addEventListener('DOMContentLoaded', () => resolve(), { once: true });
        });
    }

    const banner = document.createElement('div');
    banner.id = 'lco-enable-banner';
    banner.style.cssText = [
        'position:fixed',
        'bottom:80px',
        'right:16px',
        'z-index:2147483647',
        'display:flex',
        'align-items:center',
        'gap:12px',
        'padding:12px 16px',
        'background:rgba(24,24,27,0.95)',
        'backdrop-filter:blur(8px)',
        '-webkit-backdrop-filter:blur(8px)',
        'border:1px solid rgba(255,255,255,0.10)',
        'border-radius:8px',
        'font-family:system-ui,-apple-system,sans-serif',
        'font-size:13px',
        'color:#e4e4e7',
        'box-shadow:0 4px 24px rgba(0,0,0,0.4)',
        'pointer-events:all',
    ].join(';');

    const text = document.createElement('span');
    text.textContent = 'LCO — Enable token tracking for Claude?';

    const enableBtn = document.createElement('button');
    enableBtn.textContent = 'Enable';
    enableBtn.style.cssText = [
        'background:#7c3aed',
        'color:#fff',
        'border:none',
        'border-radius:5px',
        'padding:5px 12px',
        'font:inherit',
        'font-size:12px',
        'cursor:pointer',
        'flex-shrink:0',
    ].join(';');

    const dismissBtn = document.createElement('button');
    dismissBtn.textContent = 'Dismiss';
    dismissBtn.style.cssText = [
        'background:transparent',
        'color:#71717a',
        'border:none',
        'padding:5px 8px',
        'font:inherit',
        'font-size:12px',
        'cursor:pointer',
        'flex-shrink:0',
    ].join(';');

    banner.appendChild(text);
    banner.appendChild(enableBtn);
    banner.appendChild(dismissBtn);
    // Append to <html>, not <body> — Next.js hydrates <body> and wipes foreign children.
    document.documentElement.appendChild(banner);

    enableBtn.addEventListener('click', async () => {
        await browser.storage.local.set({ lco_enabled_claude: true });
        banner.remove();
        // Reload so initializeMonitoring() runs from document_start —
        // injectScript must intercept fetch before any page JS fires.
        window.location.reload();
    });

    dismissBtn.addEventListener('click', () => {
        banner.remove();
        // Intentionally not storing — ask again next page load.
        // User can re-enable via the extension popup (Phase 2).
    });
}

// ---------------------------------------------------------------------------
// Core monitoring — session token, message bridge, overlay
// ---------------------------------------------------------------------------

async function initializeMonitoring(): Promise<void> {
    console.log('[LCO] Content script initialized on claude.ai');

    const sessionToken = crypto.randomUUID();

    // --- Overlay DOM element references ---
    // All null until buildOverlayDOM() runs. updateOverlay() is a safe no-op until then.
    let overlayWidget: HTMLDivElement | null = null;
    let elCurrentRequest: HTMLElement | null = null;
    let elContextRow: HTMLElement | null = null;
    let elContextFill: HTMLElement | null = null;
    let elContextLabel: HTMLElement | null = null;
    let elLimitRow: HTMLElement | null = null;
    let elLimitFill: HTMLElement | null = null;
    let elLimitLabel: HTMLElement | null = null;
    let elDivider: HTMLElement | null = null;
    let elSessionRow: HTMLElement | null = null;
    let elSession: HTMLElement | null = null;
    let elHealth: HTMLElement | null = null;
    let elCostMini: HTMLElement | null = null;

    // --- Overlay data state ---
    interface OverlayState {
        lastRequest: { inputTokens: number; outputTokens: number; model: string; cost: number | null } | null;
        session: { requestCount: number; totalInputTokens: number; totalOutputTokens: number; totalCost: number | null };
        messageLimitUtilization: number | null;
        contextPct: number | null;
        healthBroken: string | null;
        streaming: boolean;
    }

    let state: OverlayState = {
        lastRequest: null,
        session: { requestCount: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCost: null },
        messageLimitUtilization: null,
        contextPct: null,
        healthBroken: null,
        streaming: false,
    };

    function fmt(n: number): string {
        return n.toLocaleString('en-US');
    }

    function fmtCost(c: number | null): string {
        if (c === null) return '—';
        if (c < 0.00001) return '$0.00*';
        return `$${c.toFixed(4)}`;
    }

    // --- Overlay DOM updater ---
    // Called after every state mutation. Safe to call before shadow DOM is ready.
    function updateOverlay(): void {
        if (!overlayWidget) return;

        // Reveal widget on first data arrival
        if (state.lastRequest !== null && overlayWidget.style.display === 'none') {
            overlayWidget.style.display = '';
        }

        if (elCurrentRequest && state.lastRequest) {
            const { inputTokens, outputTokens, cost } = state.lastRequest;
            elCurrentRequest.textContent =
                `~${fmt(inputTokens)} in · ~${fmt(outputTokens)} out · ${fmtCost(cost)}`;
        }

        if (elContextRow && elContextFill && elContextLabel) {
            const visible = state.contextPct !== null && state.contextPct > 0.1;
            elContextRow.style.display = visible ? '' : 'none';
            if (visible) {
                const pct = Math.min(state.contextPct!, 100);
                elContextFill.style.width = `${pct}%`;
                elContextLabel.textContent = `${pct.toFixed(1)}% ctx`;
                elContextFill.classList.toggle('lco-streaming', state.streaming);
            }
        }

        if (elLimitRow && elLimitFill && elLimitLabel) {
            const visible = state.messageLimitUtilization !== null;
            elLimitRow.style.display = visible ? '' : 'none';
            if (visible) {
                const pct = Math.min(state.messageLimitUtilization! * 100, 100);
                elLimitFill.style.width = `${pct}%`;
                elLimitLabel.textContent = `${pct.toFixed(0)}% limit`;
            }
        }

        // Session section (divider + row) — hidden until the first request completes
        const sessionVisible = state.session.requestCount > 0;
        if (elDivider) elDivider.style.display = sessionVisible ? '' : 'none';
        if (elSessionRow) elSessionRow.style.display = sessionVisible ? '' : 'none';
        if (elSession && sessionVisible) {
            const { requestCount, totalInputTokens, totalOutputTokens, totalCost } = state.session;
            const total = totalInputTokens + totalOutputTokens;
            elSession.textContent =
                `${requestCount} req · ~${fmt(total)} tok · ${fmtCost(totalCost)}`;
        }

        if (elHealth) {
            if (state.healthBroken) {
                elHealth.textContent = `⚠ ${state.healthBroken}`;
                elHealth.style.display = '';
            } else {
                elHealth.style.display = 'none';
            }
        }

        if (elCostMini && state.lastRequest) {
            elCostMini.textContent = fmtCost(state.lastRequest.cost);
        }
    }

    // --- Build vanilla DOM overlay inside shadow root ---
    function buildOverlayDOM(shadow: ShadowRoot): void {
        const style = document.createElement('style');
        style.textContent = OVERLAY_CSS;
        shadow.appendChild(style);

        const widget = document.createElement('div');
        widget.className = 'lco-widget';
        widget.style.display = 'none'; // hidden until first TOKEN_BATCH
        overlayWidget = widget;

        // Header — always visible, click to collapse/expand
        const header = document.createElement('div');
        header.className = 'lco-header';

        const title = document.createElement('span');
        title.className = 'lco-title';
        title.textContent = 'LCO';

        const costMini = document.createElement('span');
        costMini.className = 'lco-cost-mini';
        costMini.style.display = 'none'; // shown only when collapsed
        elCostMini = costMini;

        header.appendChild(title);
        header.appendChild(costMini);
        widget.appendChild(header);

        // Body — collapsible
        const body = document.createElement('div');
        body.className = 'lco-body';

        // Last request row
        const rowLast = document.createElement('div');
        rowLast.className = 'lco-row';
        const lblLast = document.createElement('span');
        lblLast.className = 'lco-label';
        lblLast.textContent = 'last';
        const valLast = document.createElement('span');
        valLast.className = 'lco-value lco-accent';
        valLast.textContent = '—';
        elCurrentRequest = valLast;
        rowLast.appendChild(lblLast);
        rowLast.appendChild(valLast);
        body.appendChild(rowLast);

        // Context window bar
        const ctxRow = document.createElement('div');
        ctxRow.className = 'lco-bar-row';
        ctxRow.style.display = 'none'; // hidden until contextPct > 0.1%
        elContextRow = ctxRow;
        const ctxTrack = document.createElement('div');
        ctxTrack.className = 'lco-bar-track';
        const ctxFill = document.createElement('div');
        ctxFill.className = 'lco-bar-fill';
        ctxFill.style.width = '0%';
        elContextFill = ctxFill;
        ctxTrack.appendChild(ctxFill);
        const ctxLabel = document.createElement('span');
        ctxLabel.className = 'lco-bar-label';
        ctxLabel.textContent = '—% ctx';
        elContextLabel = ctxLabel;
        ctxRow.appendChild(ctxTrack);
        ctxRow.appendChild(ctxLabel);
        body.appendChild(ctxRow);

        // Message limit bar
        const limitRow = document.createElement('div');
        limitRow.className = 'lco-bar-row';
        limitRow.style.display = 'none'; // hidden until first MESSAGE_LIMIT_UPDATE
        elLimitRow = limitRow;
        const limitTrack = document.createElement('div');
        limitTrack.className = 'lco-bar-track lco-bar-track--warn';
        const limitFill = document.createElement('div');
        limitFill.className = 'lco-bar-fill lco-bar-fill--warn';
        limitFill.style.width = '0%';
        elLimitFill = limitFill;
        limitTrack.appendChild(limitFill);
        const limitLabel = document.createElement('span');
        limitLabel.className = 'lco-bar-label';
        limitLabel.textContent = '—% limit';
        elLimitLabel = limitLabel;
        limitRow.appendChild(limitTrack);
        limitRow.appendChild(limitLabel);
        body.appendChild(limitRow);

        // Divider — hidden until first request completes
        const divider = document.createElement('div');
        divider.className = 'lco-divider';
        divider.style.display = 'none';
        elDivider = divider;
        body.appendChild(divider);

        // Session row — hidden until first request completes
        const rowSession = document.createElement('div');
        rowSession.className = 'lco-row';
        rowSession.style.display = 'none';
        elSessionRow = rowSession;
        const lblSession = document.createElement('span');
        lblSession.className = 'lco-label';
        lblSession.textContent = 'session';
        const valSession = document.createElement('span');
        valSession.className = 'lco-value';
        valSession.textContent = '—';
        elSession = valSession;
        rowSession.appendChild(lblSession);
        rowSession.appendChild(valSession);
        body.appendChild(rowSession);

        // Health warning (hidden by default)
        const health = document.createElement('div');
        health.className = 'lco-health';
        health.style.display = 'none';
        elHealth = health;
        body.appendChild(health);

        widget.appendChild(body);
        shadow.appendChild(widget);

        // Collapse/expand toggle
        let collapsed = false;
        header.addEventListener('click', () => {
            collapsed = !collapsed;
            body.style.display = collapsed ? 'none' : '';
            costMini.style.display = collapsed ? '' : 'none';
            widget.classList.toggle('lco-collapsed', collapsed);
        });
    }

    // --- 5-Layer Message Bridge: Main World (inject.js) → Service Worker ---
    // Registered synchronously before any await so no events are dropped
    // during the async injectScript / shadow DOM setup window.
    window.addEventListener('message', (event) => {
        // Layer 1: origin check
        if (event.origin !== window.location.origin) return;
        // Layer 3: namespace isolation
        if (!event.data || event.data.namespace !== LCO_NAMESPACE) return;
        // Layer 4: session token
        if (event.data.token !== sessionToken) return;
        // Layer 5: schema validation
        if (!isValidBridgeSchema(event.data)) return;

        const msg = event.data as LcoBridgeMessage;

        if (msg.type === 'TOKEN_BATCH') {
            browser.runtime.sendMessage({
                type: 'STORE_TOKEN_BATCH',
                platform: msg.platform,
                model: msg.model,
                inputTokens: msg.inputTokens,
                outputTokens: msg.outputTokens,
                stopReason: null,
            } satisfies StoreTokenBatchMessage).catch((err) => {
                console.error('[LCO-ERROR] Failed to forward TOKEN_BATCH to background:', err);
            });

            const ctxSize = getContextWindowSize(msg.model);
            state = {
                ...state,
                lastRequest: {
                    inputTokens: msg.inputTokens,
                    outputTokens: msg.outputTokens,
                    model: msg.model,
                    cost: calculateCost(msg.inputTokens, msg.outputTokens, msg.model),
                },
                contextPct: ctxSize > 0
                    ? (msg.inputTokens + msg.outputTokens) / ctxSize * 100
                    : state.contextPct,
                streaming: true,
            };
            updateOverlay();
        }

        if (msg.type === 'STREAM_COMPLETE') {
            state = {
                ...state,
                lastRequest: {
                    inputTokens: msg.inputTokens,
                    outputTokens: msg.outputTokens,
                    model: msg.model,
                    cost: calculateCost(msg.inputTokens, msg.outputTokens, msg.model),
                },
                streaming: false,
            };
            updateOverlay();

            browser.runtime.sendMessage({
                type: 'STORE_TOKEN_BATCH',
                platform: msg.platform,
                model: msg.model,
                inputTokens: msg.inputTokens,
                outputTokens: msg.outputTokens,
                stopReason: msg.stopReason ?? null,
            } satisfies StoreTokenBatchMessage)
                .then((response: StoreTokenBatchResponse) => {
                    if (!response?.ok || !response.tabState || !response.sessionCost) return;
                    const { tabState, sessionCost } = response;
                    const ctxSize = getContextWindowSize(tabState.model);
                    state = {
                        ...state,
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
                        contextPct: ctxSize > 0
                            ? (tabState.inputTokens + tabState.outputTokens) / ctxSize * 100
                            : state.contextPct,
                        messageLimitUtilization:
                            tabState.messageLimitUtilization ?? state.messageLimitUtilization,
                    };
                    updateOverlay();
                })
                .catch((err) => {
                    console.error('[LCO-ERROR] Failed to forward STREAM_COMPLETE to background:', err);
                });
        }

        if (msg.type === 'HEALTH_BROKEN') {
            console.warn('[LCO] Health check broken:', msg.message);
            state = { ...state, healthBroken: msg.message };
            updateOverlay();
        }

        if (msg.type === 'MESSAGE_LIMIT_UPDATE') {
            browser.runtime.sendMessage({
                type: 'STORE_MESSAGE_LIMIT',
                platform: msg.platform,
                messageLimitUtilization: msg.messageLimitUtilization,
            }).catch((err) => {
                console.error('[LCO-ERROR] Failed to forward message limit to background:', err);
            });
            state = { ...state, messageLimitUtilization: msg.messageLimitUtilization };
            updateOverlay();
        }
    });

    // Internal BPE token counting bridge (inject.ts → background)
    window.addEventListener('message', (event) => {
        if (event.source !== window || !event.data || event.data.type !== 'LCO_TOKEN_REQ') return;
        const { id, text } = event.data;
        browser.runtime.sendMessage({ type: 'COUNT_TOKENS', text })
            .then((response: any) => {
                const count = typeof response?.count === 'number' ? response.count : 0;
                window.postMessage({ type: 'LCO_TOKEN_RES', id, count }, window.location.origin);
            })
            .catch((err: any) => {
                console.error('[LCO-ERROR] BPE bridge failed:', err);
                window.postMessage({ type: 'LCO_TOKEN_RES', id, count: 0 }, window.location.origin);
            });
    });

    // --- Async setup (does not block message handling above) ---

    browser.storage.session.set({
        [`sessionToken_${location.hostname}`]: sessionToken,
    }).catch(() => { /* non-critical */ });

    await injectScript('/inject.js', {
        keepInDom: true,
        modifyScript(script) {
            script.dataset.sessionToken = sessionToken;
            script.dataset.platform = ClaudeAdapter.name;
            script.dataset.injectConfig = JSON.stringify(ClaudeAdapter.injectConfig);
        },
    });

    console.log('[LCO] Main-world interceptor successfully injected.');

    // --- Shadow DOM Overlay ---

    try {
        console.log('[LCO] Waiting for document.body...');

        if (!document.body) {
            await new Promise<void>(resolve => {
                if (document.readyState !== 'loading') resolve();
                else document.addEventListener('DOMContentLoaded', () => resolve(), { once: true });
            });
        }

        console.log('[LCO] document.body available');

        const host = document.createElement('div');
        host.id = 'lco-widget-host';
        // Append to <html>, not <body> — Next.js hydrates <body> and wipes foreign children.
        document.documentElement.appendChild(host);

        console.log('[LCO] Host element created');

        const shadow = host.attachShadow({ mode: 'closed' });
        buildOverlayDOM(shadow);

        console.log('[LCO] Overlay shadow DOM mounted.');

        // Reset overlay on SPA navigation (Navigation API, Chrome 102+)
        if ('navigation' in window) {
            (window as any).navigation.addEventListener('navigatesuccess', () => {
                state = {
                    lastRequest: null,
                    session: { requestCount: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCost: null },
                    messageLimitUtilization: null,
                    contextPct: null,
                    healthBroken: null,
                    streaming: false,
                };
                if (overlayWidget) overlayWidget.style.display = 'none';
                updateOverlay();
            });
        }
    } catch (err) {
        console.error('[LCO-ERROR] Overlay mount failed:', err);
    }
}

// ---------------------------------------------------------------------------
// Layer 5 schema validator (module-level — shared by both bridge listeners)
// ---------------------------------------------------------------------------

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
