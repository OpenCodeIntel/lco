// ui/overlay.ts
// Overlay DOM factory. No knowledge of message types, chrome APIs, or business logic.
// createOverlay() returns a handle with two methods:
//   mount(shadow)  — builds the DOM tree inside the given shadow root (call once)
//   render(state)  — reflects OverlayState onto the DOM (safe to call before mount)

import { OVERLAY_CSS } from './overlay-styles';
import type { OverlayState } from '../lib/overlay-state';

export interface OverlayHandle {
    mount(shadow: ShadowRoot): void;
    render(state: OverlayState): void;
}

function fmt(n: number): string {
    return n.toLocaleString('en-US');
}

function fmtCost(c: number | null): string {
    if (c === null) return '—';
    if (c < 0.00001) return '$0.00*';
    return `$${c.toFixed(4)}`;
}

export function createOverlay(): OverlayHandle {
    // DOM refs — null until mount() is called. render() is a no-op until then.
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

    function mount(shadow: ShadowRoot): void {
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
        ctxRow.style.display = 'none';
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
        limitRow.style.display = 'none';
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

        // Health warning — hidden by default
        const health = document.createElement('div');
        health.className = 'lco-health';
        health.style.display = 'none';
        elHealth = health;
        body.appendChild(health);

        widget.appendChild(body);
        shadow.appendChild(widget);

        // Collapse/expand toggle — DOM-only concern, lives here
        let collapsed = false;
        header.addEventListener('click', () => {
            collapsed = !collapsed;
            body.style.display = collapsed ? 'none' : '';
            costMini.style.display = collapsed ? '' : 'none';
            widget.classList.toggle('lco-collapsed', collapsed);
        });
    }

    function render(state: OverlayState): void {
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

    return { mount, render };
}
