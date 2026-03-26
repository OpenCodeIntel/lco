// lib/adapters/claude.ts
// Claude adapter: single source of truth for all Claude-specific constants.
//
// Previously these values were hardcoded in entrypoints/inject.ts. They now
// live here and are serialized into dataset.injectConfig by the content script
// before inject.ts is injected into the page.

import type { ProviderAdapter } from './types';

export const ClaudeAdapter: ProviderAdapter = {
    name: 'claude',
    hostPattern: 'https://claude.ai/*',
    injectConfig: {
        endpointIncludes: '/chat_conversations/',
        endpointSuffix: '/completion',
        events: {
            streamStart: 'message_start',
            contentBlockStart: 'content_block_start',
            contentDelta: 'content_block_delta',
            streamEnd: 'message_stop',
            messageLimit: 'message_limit',
            stopReason: 'message_delta',
        },
        paths: {
            messageLimitUtilization: 'message_limit.windows.overage.utilization',
            stopReason: 'delta.stop_reason',
            contentDeltaType: 'delta.type',
            contentDeltaTypeValue: 'text_delta',
            contentDeltaText: 'delta.text',
        },
        body: {
            model: 'model',
            prompt: 'prompt',
        },
    },
};
