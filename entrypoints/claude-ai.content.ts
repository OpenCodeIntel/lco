// entrypoints/claude-ai.content.ts - Content script for claude.ai (Room 2)
// Thin orchestrator: validates bridge messages, drives state transitions, renders overlay.
// All logic lives in imported modules; this file only wires them together.

import type { LcoBridgeMessage, StoreTokenBatchMessage, StoreMessageLimitMessage, StoreTokenBatchResponse, RecordTurnMessage, FinalizeConversationMessage } from '../lib/message-types';
import { LCO_NAMESPACE } from '../lib/message-types';
import { isValidBridgeSchema } from '../lib/bridge-validation';
import { INITIAL_STATE, applyTokenBatch, applyStreamComplete, applyStorageResponse, applyHealthBroken, applyHealthRecovered, applyMessageLimit } from '../lib/overlay-state';
import { createOverlay } from '../ui/overlay';
import { showEnableBanner } from '../ui/enable-banner';
import { ClaudeAdapter } from '../lib/adapters/claude';
import { analyzeContext, shouldDismiss, signalKey, pickTopSignal } from '../lib/context-intelligence';
import type { ConversationState, ContextSignal } from '../lib/context-intelligence';
import { getContextWindowSize, calculateCost } from '../lib/pricing';
import { extractConversationId } from '../lib/conversation-store';

export default defineContentScript({
    matches: ['https://claude.ai/*'],
    runAt: 'document_start',
    async main() {
        if (window !== window.top) return;
        const stored = await browser.storage.local.get('lco_enabled_claude');
        if (stored.lco_enabled_claude) {
            await initializeMonitoring();
        } else {
            await showEnableBanner();
        }
    },
});

function freshConvState(): ConversationState {
    return { turnCount: 0, contextPct: 0, contextHistory: [], model: '', contextWindow: 200000 };
}

async function initializeMonitoring(): Promise<void> {
    const sessionToken = crypto.randomUUID();
    const overlay = createOverlay();
    let state = { ...INITIAL_STATE };
    let convState = freshConvState();
    let dismissed = new Set<string>();
    let currentConversationId = extractConversationId(window.location.href);

    // 5-layer message bridge: Main World (inject.js) → Service Worker
    // Registered synchronously before any await so no events are dropped
    // during the async injectScript / shadow DOM setup window.
    window.addEventListener('message', (event) => {
        if (event.origin !== window.location.origin) return;
        if (!event.data || event.data.namespace !== LCO_NAMESPACE) return;
        if (event.data.token !== sessionToken) return;
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
            state = applyTokenBatch(state, msg);
            overlay.render(state);
        }

        if (msg.type === 'STREAM_COMPLETE') {
            state = applyStreamComplete(state, msg);
            overlay.render(state);

            // Update conversation state and evaluate signals after each complete turn.
            convState = {
                turnCount: convState.turnCount + 1,
                contextPct: state.contextPct ?? 0,
                contextHistory: [...convState.contextHistory, state.contextPct ?? 0],
                model: msg.model,
                contextWindow: getContextWindowSize(msg.model) || 200000,
            };
            const active = analyzeContext(convState).filter(s => !shouldDismiss(s, dismissed));
            const top = pickTopSignal(active);
            if (top) {
                overlay.showNudge(top, () => { dismissed.add(signalKey(top)); });
            } else {
                overlay.hideNudge();
            }

            // Persist turn to conversation history in chrome.storage.local.
            if (currentConversationId) {
                browser.runtime.sendMessage({
                    type: 'RECORD_TURN',
                    conversationId: currentConversationId,
                    inputTokens: msg.inputTokens,
                    outputTokens: msg.outputTokens,
                    model: msg.model,
                    contextPct: state.contextPct ?? 0,
                    cost: calculateCost(msg.inputTokens, msg.outputTokens, msg.model),
                } satisfies RecordTurnMessage).catch((err) => {
                    console.error('[LCO-ERROR] Failed to record conversation turn:', err);
                });
            }

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
                    state = applyStorageResponse(state, response.tabState, response.sessionCost);
                    overlay.render(state);
                })
                .catch((err) => {
                    console.error('[LCO-ERROR] Failed to forward STREAM_COMPLETE to background:', err);
                });
        }

        if (msg.type === 'HEALTH_BROKEN') {
            state = applyHealthBroken(state, msg.message);
            overlay.render(state);
        }

        if (msg.type === 'HEALTH_RECOVERED') {
            state = applyHealthRecovered(state);
            overlay.render(state);
        }

        if (msg.type === 'MESSAGE_LIMIT_UPDATE') {
            browser.runtime.sendMessage({
                type: 'STORE_MESSAGE_LIMIT',
                platform: msg.platform,
                messageLimitUtilization: msg.messageLimitUtilization,
            } satisfies StoreMessageLimitMessage).catch((err) => {
                console.error('[LCO-ERROR] Failed to forward MESSAGE_LIMIT_UPDATE to background:', err);
            });
            state = applyMessageLimit(state, msg.messageLimitUtilization);
            overlay.render(state);
        }
    });

    // Internal BPE token counting relay: inject.ts → background
    window.addEventListener('message', (event) => {
        if (event.source !== window || !event.data || event.data.type !== 'LCO_TOKEN_REQ') return;
        const { id, text } = event.data;
        browser.runtime.sendMessage({ type: 'COUNT_TOKENS', text })
            .then((response: { count?: number }) => {
                const count = typeof response?.count === 'number' ? response.count : 0;
                window.postMessage({ type: 'LCO_TOKEN_RES', id, count }, window.location.origin);
            })
            .catch((err) => {
                console.error('[LCO-ERROR] BPE bridge failed:', err);
                window.postMessage({ type: 'LCO_TOKEN_RES', id, count: 0 }, window.location.origin);
            });
    });

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

    if (!document.body) {
        await new Promise<void>(resolve => {
            if (document.readyState !== 'loading') resolve();
            else document.addEventListener('DOMContentLoaded', () => resolve(), { once: true });
        });
    }

    const host = document.createElement('div');
    host.id = 'lco-widget-host';
    document.documentElement.appendChild(host);
    const shadow = host.attachShadow({ mode: 'closed' });
    overlay.mount(shadow);

    // Reset overlay, conversation state, and dismissed nudges on SPA navigation (Chrome 102+).
    // Also finalize the previous conversation and detect the new one.
    if ('navigation' in window) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).navigation.addEventListener('navigatesuccess', () => {
            const newId = extractConversationId(window.location.href);

            // Finalize the old conversation if navigating to a different one.
            if (currentConversationId && currentConversationId !== newId) {
                browser.runtime.sendMessage({
                    type: 'FINALIZE_CONVERSATION',
                    conversationId: currentConversationId,
                } satisfies FinalizeConversationMessage).catch((err) => {
                    console.error('[LCO-ERROR] Failed to finalize conversation:', err);
                });
            }
            currentConversationId = newId;

            state = { ...INITIAL_STATE };
            convState = freshConvState();
            dismissed = new Set();
            overlay.render(state);
            overlay.hideNudge();
        });
    }
}
