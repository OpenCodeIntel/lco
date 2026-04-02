// @vitest-environment happy-dom
// Tests for showNudge / hideNudge in ui/overlay.ts.
// Uses happy-dom for a lightweight DOM environment.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createOverlay } from '../../ui/overlay';
import { INITIAL_STATE } from '../../lib/overlay-state';
import type { ContextSignal } from '../../lib/context-intelligence';

const INFO_SIGNAL: ContextSignal = {
    type: 'threshold',
    severity: 'info',
    message: 'Context is 60% full. Responses may start losing earlier details.',
    dismissible: true,
};

const WARN_SIGNAL: ContextSignal = {
    type: 'growth_warning',
    severity: 'warning',
    message: '~3 more messages until context limit.',
    dismissible: true,
};

const CRITICAL_SIGNAL: ContextSignal = {
    type: 'threshold',
    severity: 'critical',
    message: 'Context is nearly full. Start a new chat.',
    dismissible: false,
};

function mountOverlay() {
    const overlay = createOverlay();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' }); // open so tests can query inside
    overlay.mount(shadow);
    overlay.render(INITIAL_STATE);
    return { overlay, shadow, host };
}

function getNudge(shadow: ShadowRoot): HTMLElement | null {
    return shadow.querySelector('.lco-nudge');
}

beforeEach(() => {
    document.body.innerHTML = '';
    vi.useFakeTimers();
});

// ── showNudge ─────────────────────────────────────────────────────────────────

describe('showNudge', () => {
    it('makes the nudge element visible', () => {
        const { overlay, shadow } = mountOverlay();
        overlay.showNudge(INFO_SIGNAL, () => {});
        const el = getNudge(shadow);
        expect(el).not.toBeNull();
        expect(el!.style.display).not.toBe('none');
    });

    it('sets the correct message text', () => {
        const { overlay, shadow } = mountOverlay();
        overlay.showNudge(INFO_SIGNAL, () => {});
        const msg = shadow.querySelector('.lco-nudge-msg');
        expect(msg?.textContent).toBe(INFO_SIGNAL.message);
    });

    it('applies the correct severity class for info', () => {
        const { overlay, shadow } = mountOverlay();
        overlay.showNudge(INFO_SIGNAL, () => {});
        expect(getNudge(shadow)?.classList.contains('lco-nudge--info')).toBe(true);
    });

    it('applies the correct severity class for warning', () => {
        const { overlay, shadow } = mountOverlay();
        overlay.showNudge(WARN_SIGNAL, () => {});
        expect(getNudge(shadow)?.classList.contains('lco-nudge--warning')).toBe(true);
    });

    it('applies the correct severity class for critical', () => {
        const { overlay, shadow } = mountOverlay();
        overlay.showNudge(CRITICAL_SIGNAL, () => {});
        expect(getNudge(shadow)?.classList.contains('lco-nudge--critical')).toBe(true);
    });

    it('shows dismiss button for dismissible signals', () => {
        const { overlay, shadow } = mountOverlay();
        overlay.showNudge(INFO_SIGNAL, () => {});
        const btn = shadow.querySelector<HTMLElement>('.lco-nudge-dismiss');
        expect(btn?.style.display).not.toBe('none');
    });

    it('hides dismiss button for non-dismissible signals', () => {
        const { overlay, shadow } = mountOverlay();
        overlay.showNudge(CRITICAL_SIGNAL, () => {});
        const btn = shadow.querySelector<HTMLElement>('.lco-nudge-dismiss');
        expect(btn?.style.display).toBe('none');
    });

    it('replaces content when called a second time', () => {
        const { overlay, shadow } = mountOverlay();
        overlay.showNudge(INFO_SIGNAL, () => {});
        overlay.showNudge(WARN_SIGNAL, () => {});
        const msg = shadow.querySelector('.lco-nudge-msg');
        expect(msg?.textContent).toBe(WARN_SIGNAL.message);
        expect(getNudge(shadow)?.classList.contains('lco-nudge--warning')).toBe(true);
    });
});

// ── dismiss button ────────────────────────────────────────────────────────────

describe('dismiss button', () => {
    it('calls onDismiss when clicked', () => {
        const { overlay, shadow } = mountOverlay();
        const onDismiss = vi.fn();
        overlay.showNudge(INFO_SIGNAL, onDismiss);
        const btn = shadow.querySelector<HTMLButtonElement>('.lco-nudge-dismiss');
        btn?.click();
        expect(onDismiss).toHaveBeenCalledOnce();
    });

    it('does not call previous onDismiss after showNudge is called again', () => {
        const { overlay, shadow } = mountOverlay();
        const firstDismiss = vi.fn();
        const secondDismiss = vi.fn();
        overlay.showNudge(INFO_SIGNAL, firstDismiss);
        overlay.showNudge(WARN_SIGNAL, secondDismiss);
        shadow.querySelector<HTMLButtonElement>('.lco-nudge-dismiss')?.click();
        expect(firstDismiss).not.toHaveBeenCalled();
        expect(secondDismiss).toHaveBeenCalledOnce();
    });

    it('does not fire onDismiss twice on double click', () => {
        const { overlay, shadow } = mountOverlay();
        const onDismiss = vi.fn();
        overlay.showNudge(INFO_SIGNAL, onDismiss);
        const btn = shadow.querySelector<HTMLButtonElement>('.lco-nudge-dismiss');
        btn?.click();
        btn?.click();
        expect(onDismiss).toHaveBeenCalledOnce();
    });
});

// ── hideNudge ─────────────────────────────────────────────────────────────────

describe('hideNudge', () => {
    it('adds exiting class immediately', () => {
        const { overlay, shadow } = mountOverlay();
        overlay.showNudge(INFO_SIGNAL, () => {});
        overlay.hideNudge();
        expect(getNudge(shadow)?.classList.contains('lco-nudge--exiting')).toBe(true);
    });

    it('hides element after 200ms animation', () => {
        const { overlay, shadow } = mountOverlay();
        overlay.showNudge(INFO_SIGNAL, () => {});
        overlay.hideNudge();
        vi.advanceTimersByTime(200);
        expect(getNudge(shadow)?.style.display).toBe('none');
    });

    it('removes exiting class after hiding', () => {
        const { overlay, shadow } = mountOverlay();
        overlay.showNudge(INFO_SIGNAL, () => {});
        overlay.hideNudge();
        vi.advanceTimersByTime(200);
        expect(getNudge(shadow)?.classList.contains('lco-nudge--exiting')).toBe(false);
    });

    it('is a no-op before mount', () => {
        // Should not throw
        const overlay = createOverlay();
        expect(() => overlay.hideNudge()).not.toThrow();
    });

    it('cancels a pending hide when showNudge is called during exit', () => {
        const { overlay, shadow } = mountOverlay();
        overlay.showNudge(INFO_SIGNAL, () => {});
        overlay.hideNudge();
        // Call showNudge before the 200ms timer fires
        overlay.showNudge(WARN_SIGNAL, () => {});
        vi.advanceTimersByTime(200);
        // Element should still be visible with the new signal
        expect(getNudge(shadow)?.style.display).not.toBe('none');
        expect(shadow.querySelector('.lco-nudge-msg')?.textContent).toBe(WARN_SIGNAL.message);
    });
});
