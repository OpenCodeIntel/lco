// ui/overlay-styles.ts
// CSS exported as a string constant so it can be injected into a closed Shadow DOM
// without depending on Vite's ?inline query or WXT's CSS injection pipeline.

export const OVERLAY_CSS = `
:host {
  --lco-bg: rgba(24, 24, 27, 0.93);
  --lco-text: #e4e4e7;
  --lco-muted: #71717a;
  --lco-accent: #a78bfa;
  --lco-bar-fill: #7c3aed;
  --lco-bar-bg: rgba(124, 58, 237, 0.2);
  --lco-warn: #fbbf24;
  --lco-border: rgba(255, 255, 255, 0.08);
}

@media (prefers-color-scheme: light) {
  :host {
    --lco-bg: rgba(255, 255, 255, 0.96);
    --lco-text: #18181b;
    --lco-muted: #71717a;
    --lco-accent: #7c3aed;
    --lco-bar-fill: #7c3aed;
    --lco-bar-bg: rgba(124, 58, 237, 0.15);
    --lco-warn: #d97706;
    --lco-border: rgba(0, 0, 0, 0.1);
  }
}

.lco-widget {
  position: fixed;
  bottom: 16px;
  right: 16px;
  z-index: 2147483647;
  background: var(--lco-bg);
  color: var(--lco-text);
  border-radius: 8px;
  padding: 7px 11px;
  font-family: ui-monospace, 'SF Mono', 'Cascadia Code', Menlo, monospace;
  font-size: 11px;
  line-height: 1.6;
  min-width: 190px;
  max-width: 280px;
  border: 1px solid var(--lco-border);
  backdrop-filter: blur(8px);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.35);
  user-select: none;
}

.lco-row {
  display: flex;
  align-items: baseline;
  gap: 5px;
  white-space: nowrap;
}

.lco-label {
  color: var(--lco-muted);
  flex-shrink: 0;
  font-size: 10px;
}

.lco-value {
  color: var(--lco-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lco-accent {
  color: var(--lco-accent);
}

.lco-divider {
  height: 1px;
  background: var(--lco-border);
  margin: 5px 0;
}

.lco-bar-track {
  height: 3px;
  background: var(--lco-bar-bg);
  border-radius: 2px;
  overflow: hidden;
  margin: 2px 0 3px;
}

.lco-bar-fill {
  height: 100%;
  background: var(--lco-bar-fill);
  border-radius: 2px;
  transition: width 0.4s ease;
}

.lco-warn {
  color: var(--lco-warn);
  font-size: 10px;
}

@media (prefers-reduced-motion: reduce) {
  .lco-bar-fill { transition: none; }
  .lco-widget { backdrop-filter: none; }
}
`;
