// lib/platform-config.ts
// Centralized configuration for provider endpoints and SSE event hierarchies.
//
// Not currently imported anywhere. This is scaffolding for LCO-14 (Provider
// Abstraction Layer), which will make this the single source of truth for all
// platform configurations. Do not delete.
//
// inject.ts (Room 1) cannot import this file because it runs in the MAIN world
// and must remain free of chrome.* references. LCO-14 will serialize the
// relevant config into dataset attributes at injection time.

export const PROVIDER_CONFIG = {
    claude: {
        // Targets the Claude web UI completions stream.
        // We match via the unique '/chat_conversations/' directory to prevent 
        // broad collisions with generic '/completion' analytics APIs.
        endpoints: ['/chat_conversations/'],
        sentinels: ['message_start', 'content_block_stop', 'message_delta'],
        terminator: 'message_stop',
    },
    chatgpt: {
        // Target definitions for ChatGPT web GUI
        endpoints: ['/backend-api/conversation'],
        sentinels: ['choices', 'delta'],
        terminator: '[DONE]',
    },
} as const;

export type ProviderName = keyof typeof PROVIDER_CONFIG;
