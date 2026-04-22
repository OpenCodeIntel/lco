// lib/format.ts
// Pure formatting utilities shared across overlay, dashboard, and handoff-summary.
// No DOM refs, no chrome.* APIs.

/**
 * Format token count for compact display.
 * 1234 -> "1.2k", 1234567 -> "1.2M", 500 -> "500"
 */
export function formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
}

/**
 * Format cost in dollars.
 * null -> "$0.00*" (unknown model), 1.5 -> "$1.50", 100 -> "$100.00".
 *
 * Auto-promotes to 4 decimals when a positive fractional amount would otherwise
 * round to "$0.00" at the default 2-decimal precision. Keeps displayed cost
 * consistent across surfaces: a $0.0029 session reads as $0.0029 in both the
 * overlay and the side panel, never $0.00 on one and $0.0029 on the other.
 * Only activates when the caller accepts the default precision; explicit
 * decimals arguments (e.g. decimals: 6) are respected as-is.
 *
 * @param decimals - number of decimal places (default 2 for dashboard, use 4 for per-request overlay)
 */
export function formatCost(cost: number | null, decimals: number = 2): string {
    if (cost === null) return '$0.00*';
    if (decimals === 2 && cost > 0 && cost < 0.01) {
        return `$${cost.toFixed(4)}`;
    }
    return `$${cost.toFixed(decimals)}`;
}

/**
 * Format a model identifier for human display.
 * "claude-sonnet-4-6" -> "Sonnet 4.6"
 * "claude-opus-4-6" -> "Opus 4.6"
 * Unknown models return the raw string.
 */
export function formatModel(model: string): string {
    const match = model.match(/claude-(\w+)-(\d+)-(\d+)/i);
    if (match) {
        const name = match[1].charAt(0).toUpperCase() + match[1].slice(1);
        return `${name} ${match[2]}.${match[3]}`;
    }
    return model;
}

/**
 * Format a timestamp as a relative time string.
 * Within 60s: "just now"
 * Within 60m: "5m ago"
 * Within 24h: "2h ago"
 * Within 48h: "yesterday"
 * Older: "Mar 28" (month + day)
 */
export function formatRelativeTime(timestamp: number, now: number = Date.now()): string {
    const diffMs = now - timestamp;
    if (diffMs < 0) return 'just now';

    const seconds = Math.floor(diffMs / 1000);
    if (seconds < 60) return 'just now';

    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;

    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;

    if (hours < 48) return 'yesterday';

    const date = new Date(timestamp);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${months[date.getMonth()]} ${date.getDate()}`;
}
