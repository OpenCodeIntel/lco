// ui/enable-banner.ts
// JIT permission banner shown on first visit to claude.ai.
// Appended to <html> (not <body>) — Next.js hydrates <body> and wipes foreign children.
// On enable: stores the grant flag and reloads so inject.ts runs at document_start.
// On dismiss: removes the banner without storing; will reappear next page load.

export async function showEnableBanner(): Promise<void> {
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
    document.documentElement.appendChild(banner);

    enableBtn.addEventListener('click', async () => {
        await browser.storage.local.set({ lco_enabled_claude: true });
        banner.remove();
        window.location.reload();
    });

    dismissBtn.addEventListener('click', () => {
        banner.remove();
    });
}
