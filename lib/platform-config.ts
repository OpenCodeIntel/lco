// lib/platform-config.ts
// Source-of-truth config for provider endpoints and SSE event types.
// inject.ts does NOT import this file (it's self-contained in the MAIN world).
// This module is used by Room 2 (content script) and Room 3 (service worker).

export const PROVIDER_CONFIG = {
    claude: {
        // VERIFIED: Full path is /api/organizations/{uuid}/chat_conversations/{uuid}/completion
        // '/chat_conversations/' is specific enough — won't match analytics or auth calls
        // '/completion' alone is too broad — other endpoints might use it
        endpoints: ['/chat_conversations/'],
        sentinels: ['message_start', 'content_block_stop', 'message_delta'],
        terminator: 'message_stop',
    },
    chatgpt: {
        // VERIFY in DevTools before first run
        endpoints: ['/backend-api/conversation'],
        sentinels: ['choices', 'delta'],
        terminator: '[DONE]',
    },
} as const;

export type ProviderName = keyof typeof PROVIDER_CONFIG;
