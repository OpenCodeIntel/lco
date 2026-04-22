// ui/overlay.ts
// Overlay DOM factory. No knowledge of message types, chrome APIs, or business logic.
// createOverlay() returns a handle with two methods:
//   mount(shadow)  — builds the DOM tree inside the given shadow root (call once)
//   render(state)  — reflects OverlayState onto the DOM (safe to call before mount)

import { OVERLAY_CSS } from './overlay-styles';
import type { OverlayState } from '../lib/overlay-state';
import type { ContextSignal } from '../lib/context-intelligence';

export interface OverlayHandle {
    mount(shadow: ShadowRoot): void;
    render(state: OverlayState): void;
    showNudge(signal: ContextSignal, onDismiss: () => void): void;
    hideNudge(): void;
    /** Register the callback for the "Start fresh" button. Called once at setup. */
    onStartFresh(callback: () => void): void;
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
    let elHeroCost: HTMLElement | null = null;
    let elLastReplyRow: HTMLElement | null = null;
    let elLastReplyValue: HTMLElement | null = null;
    let elContextHead: HTMLElement | null = null;
    let elContextHeadPct: HTMLElement | null = null;
    let elContextRow: HTMLElement | null = null;
    let elContextFill: HTMLElement | null = null;
    let elCoaching: HTMLElement | null = null;
    let elStartFresh: HTMLButtonElement | null = null;
    let startFreshCallback: (() => void) | null = null;
    let elLimitHead: HTMLElement | null = null;
    let elLimitHeadPct: HTMLElement | null = null;
    let elLimitRow: HTMLElement | null = null;
    let elLimitFill: HTMLElement | null = null;
    let elNudge: HTMLElement | null = null;
    let elNudgeMsg: HTMLElement | null = null;
    let elNudgeDismiss: HTMLButtonElement | null = null;
    let elHealth: HTMLElement | null = null;
    let elCostMini: HTMLElement | null = null;
    let elHealthDotMini: HTMLElement | null = null;
    let nudgeHideTimer: ReturnType<typeof setTimeout> | null = null;
    let elDraftRow: HTMLElement | null = null;
    let elDraftValue: HTMLElement | null = null;
    let elDraftCompare: HTMLElement | null = null;
    let elDraftWarning: HTMLElement | null = null;

    function mount(shadow: ShadowRoot): void {
        const style = document.createElement('style');
        style.textContent = OVERLAY_CSS;
        shadow.appendChild(style);

        const widget = document.createElement('div');
        widget.className = 'lco-widget';
        widget.style.display = 'none'; // hidden until first TOKEN_BATCH
        overlayWidget = widget;

        // Header: brand left, session-total mini (collapsed only), health dot right.
        // Dot stays visible expanded and collapsed: it is the sole health signal.
        const header = document.createElement('div');
        header.className = 'lco-header';

        const title = document.createElement('span');
        title.className = 'lco-title';
        title.textContent = 'SAAR';

        const costMini = document.createElement('span');
        costMini.className = 'lco-cost-mini';
        costMini.style.display = 'none'; // shown only when collapsed
        elCostMini = costMini;

        const healthDotMini = document.createElement('span');
        healthDotMini.className = 'lco-health-dot';
        elHealthDotMini = healthDotMini;

        header.appendChild(title);
        header.appendChild(costMini);
        header.appendChild(healthDotMini);
        widget.appendChild(header);

        // Body — collapsible.
        const body = document.createElement('div');
        body.className = 'lco-body';

        // Draft estimate rows: pre-submit preview, above the hero.
        const draftRow = document.createElement('div');
        draftRow.className = 'lco-draft-row';
        draftRow.style.display = 'none';
        elDraftRow = draftRow;
        const lblDraft = document.createElement('span');
        lblDraft.className = 'lco-label';
        lblDraft.textContent = 'draft';
        const valDraft = document.createElement('span');
        valDraft.className = 'lco-value';
        elDraftValue = valDraft;
        draftRow.appendChild(lblDraft);
        draftRow.appendChild(valDraft);
        body.appendChild(draftRow);

        const draftCompare = document.createElement('div');
        draftCompare.className = 'lco-draft-compare';
        draftCompare.style.display = 'none';
        elDraftCompare = draftCompare;
        body.appendChild(draftCompare);

        const draftWarning = document.createElement('div');
        draftWarning.className = 'lco-draft-warning';
        draftWarning.style.display = 'none';
        elDraftWarning = draftWarning;
        body.appendChild(draftWarning);

        // Hero: session total cost dominates the widget.
        const heroCost = document.createElement('div');
        heroCost.className = 'lco-hero-cost';
        heroCost.textContent = '$0.00';
        elHeroCost = heroCost;
        body.appendChild(heroCost);

        const subLabel = document.createElement('div');
        subLabel.className = 'lco-sub-label';
        subLabel.textContent = 'session total';
        body.appendChild(subLabel);

        // Last reply: muted label + terra cotta value. Hidden until first reply.
        const lastReply = document.createElement('div');
        lastReply.className = 'lco-last-reply';
        lastReply.style.display = 'none';
        elLastReplyRow = lastReply;
        const lblLast = document.createElement('span');
        lblLast.className = 'lco-last-reply__label';
        lblLast.textContent = 'last reply';
        const valLast = document.createElement('span');
        valLast.className = 'lco-last-reply__value';
        valLast.textContent = '—';
        elLastReplyValue = valLast;
        lastReply.appendChild(lblLast);
        lastReply.appendChild(valLast);
        body.appendChild(lastReply);

        // Context bar: stacked head (label + percent) + thin track underneath.
        const ctxHead = document.createElement('div');
        ctxHead.className = 'lco-bar-head';
        ctxHead.style.display = 'none';
        elContextHead = ctxHead;
        const ctxHeadLabel = document.createElement('span');
        ctxHeadLabel.className = 'lco-bar-head__label';
        ctxHeadLabel.textContent = 'context';
        const ctxHeadPct = document.createElement('span');
        ctxHeadPct.className = 'lco-bar-head__value';
        ctxHeadPct.textContent = '—%';
        elContextHeadPct = ctxHeadPct;
        ctxHead.appendChild(ctxHeadLabel);
        ctxHead.appendChild(ctxHeadPct);
        body.appendChild(ctxHead);

        const ctxRow = document.createElement('div');
        ctxRow.className = 'lco-bar-row';
        ctxRow.style.display = 'none';
        elContextRow = ctxRow;
        const ctxTrack = document.createElement('div');
        ctxTrack.className = 'lco-bar-track';
        const ctxFill = document.createElement('div');
        ctxFill.className = 'lco-bar-fill';
        ctxFill.style.transform = 'scaleX(0)';
        elContextFill = ctxFill;
        ctxTrack.appendChild(ctxFill);
        ctxRow.appendChild(ctxTrack);
        body.appendChild(ctxRow);

        // Coaching text: full opacity, 10px, slide-up + fade on mount.
        const coaching = document.createElement('div');
        coaching.className = 'lco-coaching-text';
        coaching.style.display = 'none';
        elCoaching = coaching;
        body.appendChild(coaching);

        // "Start fresh" button: visible when Degrading or Critical.
        // Critical gets a filled variant; degrading keeps the outline.
        const freshBtn = document.createElement('button');
        freshBtn.className = 'lco-start-fresh';
        freshBtn.textContent = 'Start fresh';
        freshBtn.style.display = 'none';
        freshBtn.addEventListener('click', () => {
            if (startFreshCallback) startFreshCallback();
        });
        elStartFresh = freshBtn;
        body.appendChild(freshBtn);

        // Message limit bar: same stacked layout, always terra cotta warn.
        const limitHead = document.createElement('div');
        limitHead.className = 'lco-bar-head lco-bar-head--warn';
        limitHead.style.display = 'none';
        elLimitHead = limitHead;
        const limitHeadLabel = document.createElement('span');
        limitHeadLabel.className = 'lco-bar-head__label';
        limitHeadLabel.textContent = 'message limit';
        const limitHeadPct = document.createElement('span');
        limitHeadPct.className = 'lco-bar-head__value';
        limitHeadPct.textContent = '—%';
        elLimitHeadPct = limitHeadPct;
        limitHead.appendChild(limitHeadLabel);
        limitHead.appendChild(limitHeadPct);
        body.appendChild(limitHead);

        const limitRow = document.createElement('div');
        limitRow.className = 'lco-bar-row';
        limitRow.style.display = 'none';
        elLimitRow = limitRow;
        const limitTrack = document.createElement('div');
        limitTrack.className = 'lco-bar-track lco-bar-track--warn';
        const limitFill = document.createElement('div');
        limitFill.className = 'lco-bar-fill lco-bar-fill--warn';
        limitFill.style.transform = 'scaleX(0)';
        elLimitFill = limitFill;
        limitTrack.appendChild(limitFill);
        limitRow.appendChild(limitTrack);
        body.appendChild(limitRow);

        // Nudge — hidden by default, shown by showNudge().
        const nudge = document.createElement('div');
        nudge.style.display = 'none';
        elNudge = nudge;
        const nudgeMsg = document.createElement('span');
        nudgeMsg.className = 'lco-nudge-msg';
        elNudgeMsg = nudgeMsg;
        const nudgeDismiss = document.createElement('button');
        nudgeDismiss.className = 'lco-nudge-dismiss';
        nudgeDismiss.setAttribute('aria-label', 'Dismiss');
        nudgeDismiss.textContent = '×';
        elNudgeDismiss = nudgeDismiss;
        nudge.appendChild(nudgeMsg);
        nudge.appendChild(nudgeDismiss);
        body.appendChild(nudge);

        // Broken-state health warning (not the three-state label).
        const health = document.createElement('div');
        health.className = 'lco-health';
        health.style.display = 'none';
        elHealth = health;
        body.appendChild(health);

        widget.appendChild(body);
        shadow.appendChild(widget);

        // Collapse/expand toggle. Dot stays visible in both states.
        let collapsed = false;
        header.addEventListener('click', () => {
            collapsed = !collapsed;
            body.classList.toggle('lco-body--collapsed', collapsed);
            costMini.style.display = collapsed ? '' : 'none';
            widget.classList.toggle('lco-collapsed', collapsed);
        });
    }

    function render(state: OverlayState): void {
        if (!overlayWidget) return;

        // Reveal widget on first data arrival or when draft estimate is available.
        if ((state.lastRequest !== null || state.draftEstimate !== null) && overlayWidget.style.display === 'none') {
            overlayWidget.style.display = '';
        }

        // Draft estimate: pre-submit cost preview.
        if (elDraftRow && elDraftValue) {
            const draft = state.draftEstimate;
            if (draft) {
                elDraftRow.style.display = '';
                if (draft.estimatedSessionPct !== null) {
                    elDraftValue.textContent =
                        `~${fmt(draft.estimatedTokens)} tokens  ~${draft.estimatedSessionPct.toFixed(1)}% of session`;
                } else {
                    elDraftValue.textContent = `~${fmt(draft.estimatedTokens)} tokens`;
                }
            } else {
                elDraftRow.style.display = 'none';
                elDraftValue.textContent = '';
            }
        }
        if (elDraftCompare) {
            const comparisons = state.draftEstimate?.modelComparisons ?? [];
            if (comparisons.length > 0) {
                elDraftCompare.textContent = comparisons
                    .map(c => `${c.label}: ~${c.estimatedPct.toFixed(1)}%`)
                    .join('  ');
                elDraftCompare.style.display = '';
            } else {
                elDraftCompare.style.display = 'none';
            }
        }
        if (elDraftWarning) {
            const warning = state.draftEstimate?.warning ?? null;
            if (warning) {
                elDraftWarning.textContent = warning;
                elDraftWarning.style.display = '';
            } else {
                elDraftWarning.style.display = 'none';
            }
        }

        // Hero: session total dominates. Critical health swaps terra cotta for red.
        if (elHeroCost) {
            const total = state.session.totalCost;
            elHeroCost.textContent = total !== null && total > 0 ? fmtCost(total) : '$0.00';
            elHeroCost.classList.toggle('lco-hero-cost--critical', state.health?.level === 'critical');
        }

        // Last reply: show when first reply lands.
        if (elLastReplyRow && elLastReplyValue) {
            if (state.lastRequest) {
                elLastReplyValue.textContent = fmtCost(state.lastRequest.cost);
                elLastReplyRow.style.display = '';
            } else {
                elLastReplyRow.style.display = 'none';
            }
        }

        // Context bar: stacked head (label + health-colored percent) + track below.
        if (elContextHead && elContextHeadPct && elContextRow && elContextFill) {
            const visible = state.contextPct !== null && state.contextPct > 0.1;
            elContextHead.style.display = visible ? '' : 'none';
            elContextRow.style.display = visible ? '' : 'none';
            if (visible) {
                const pct = Math.min(state.contextPct!, 100);
                const level = state.health?.level ?? 'healthy';
                elContextFill.style.transform = `scaleX(${pct / 100})`;
                elContextFill.className = `lco-bar-fill lco-bar-fill--${level}`;
                elContextFill.classList.toggle('lco-streaming', state.streaming);
                elContextHeadPct.textContent = `${pct.toFixed(0)}%`;
                elContextHeadPct.className = `lco-bar-head__value lco-bar-head__value--${level}`;
            }
        }

        // Coaching text: from health score, rendered only when not healthy.
        if (elCoaching) {
            if (state.health && state.health.level !== 'healthy') {
                elCoaching.textContent = state.health.coaching;
                elCoaching.style.display = '';
            } else {
                elCoaching.style.display = 'none';
            }
        }

        // "Start fresh" button: degrading outline, critical filled.
        if (elStartFresh) {
            const showFresh = state.health !== null && state.health.level !== 'healthy';
            elStartFresh.style.display = showFresh ? '' : 'none';
            elStartFresh.classList.toggle('lco-start-fresh--critical', state.health?.level === 'critical');
        }

        // Message limit bar: stacked head + track, always terra cotta warn tint.
        if (elLimitHead && elLimitHeadPct && elLimitRow && elLimitFill) {
            const visible = state.messageLimitUtilization !== null;
            elLimitHead.style.display = visible ? '' : 'none';
            elLimitRow.style.display = visible ? '' : 'none';
            if (visible) {
                const pct = Math.min(state.messageLimitUtilization! * 100, 100);
                elLimitFill.style.transform = `scaleX(${pct / 100})`;
                elLimitHeadPct.textContent = `${pct.toFixed(0)}%`;
            }
        }

        if (elHealth) {
            if (state.healthBroken) {
                elHealth.textContent = `⚠ ${state.healthBroken}`;
                elHealth.style.display = '';
            } else {
                elHealth.style.display = 'none';
            }
        }

        // Collapsed pill: SAAR + session total + health dot (GET-15 contract).
        if (elCostMini && state.session.requestCount > 0) {
            elCostMini.textContent = fmtCost(state.session.totalCost);
        }

        if (elHealthDotMini) {
            const level = state.health?.level ?? 'healthy';
            elHealthDotMini.className = `lco-health-dot lco-health-dot--${level}`;
        }
    }

    function showNudge(signal: ContextSignal, onDismiss: () => void): void {
        if (!elNudge || !elNudgeMsg || !elNudgeDismiss) return;

        // Cancel any in-progress hide animation before showing new content.
        if (nudgeHideTimer !== null) {
            clearTimeout(nudgeHideTimer);
            nudgeHideTimer = null;
        }

        elNudge.className = `lco-nudge lco-nudge--${signal.severity}`;
        elNudgeMsg.textContent = signal.message;
        elNudgeDismiss.style.display = signal.dismissible ? '' : 'none';

        // Replace dismiss listener with a fresh one bound to the current signal.
        const freshDismiss = elNudgeDismiss.cloneNode(true) as HTMLButtonElement;
        elNudgeDismiss.replaceWith(freshDismiss);
        elNudgeDismiss = freshDismiss;
        elNudgeDismiss.addEventListener('click', () => {
            onDismiss();
            hideNudge();
        }, { once: true });

        elNudge.style.display = '';
    }

    function hideNudge(): void {
        if (!elNudge) return;
        elNudge.classList.add('lco-nudge--exiting');
        nudgeHideTimer = setTimeout(() => {
            if (elNudge) {
                elNudge.style.display = 'none';
                elNudge.classList.remove('lco-nudge--exiting');
            }
            nudgeHideTimer = null;
        }, 200);
    }

    function onStartFresh(callback: () => void): void {
        startFreshCallback = callback;
    }

    return { mount, render, showNudge, hideNudge, onStartFresh };
}
