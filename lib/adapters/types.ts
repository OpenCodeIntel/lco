// lib/adapters/types.ts
// Shared interfaces for the provider abstraction layer.
//
// InjectConfig is the serializable subset passed to inject.ts via dataset
// attributes. It contains only plain data (no functions) so it can survive
// JSON.stringify / JSON.parse across the MAIN world boundary.
//
// ProviderAdapter is the full interface used in lib/ and content scripts.
// inject.ts cannot import this file directly; it receives InjectConfig via
// document.currentScript.dataset.injectConfig at injection time.

/** Serializable config passed to inject.ts via dataset.injectConfig. */
export interface InjectConfig {
    /** Substring the URL must contain to be a completion endpoint. */
    endpointIncludes: string;
    /** Suffix the URL must end with (before any query string) to match. */
    endpointSuffix: string;

    /** Provider-specific SSE event type names mapped to canonical roles. */
    events: {
        streamStart: string;
        contentBlockStart: string;
        contentDelta: string;
        streamEnd: string;
        messageLimit: string;
        stopReason: string;
    };

    /**
     * Dot-notation paths used to extract values from SSE event objects.
     * Example: 'delta.stop_reason' resolves evt.delta.stop_reason.
     */
    paths: {
        messageLimitUtilization: string;
        stopReason: string;
        contentDeltaType: string;
        contentDeltaTypeValue: string;
        contentDeltaText: string;
    };

    /** Field names to read from the request body JSON. */
    body: {
        model: string;
        prompt: string;
    };
}

/** Full provider descriptor used in lib/ and content scripts. */
export interface ProviderAdapter {
    /** Short identifier: 'claude', 'chatgpt', etc. */
    name: string;
    /** Host pattern for wxt.config.ts matches and optional_host_permissions. */
    hostPattern: string;
    /** Config serialized into dataset.injectConfig at script injection time. */
    injectConfig: InjectConfig;
}
