// lib/platform-config.ts
// Central adapter registry. Import from here to get any provider's config.
//
// inject.ts (Room 1) cannot import this file because it runs in the MAIN world
// and must remain free of chrome.* references. The content script reads the
// relevant adapter from this registry and serializes it into dataset attributes
// before injecting the script.

import { ClaudeAdapter } from './adapters/claude';
import type { ProviderAdapter } from './adapters/types';

export const ADAPTERS: Record<string, ProviderAdapter> = {
    claude: ClaudeAdapter,
};

export type ProviderName = keyof typeof ADAPTERS;
