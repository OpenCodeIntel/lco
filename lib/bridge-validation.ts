// lib/bridge-validation.ts
// Layer 5 schema validator for the 5-layer postMessage bridge.
// Called by the content script after origin, source, namespace, and token checks pass.
// Returns true only when the message shape matches a known LcoBridgeMessage type.

import { LCO_NAMESPACE } from './message-types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isValidBridgeSchema(data: any): boolean {
    if (typeof data !== 'object' || data === null) return false;
    if (data.namespace !== LCO_NAMESPACE) return false;
    if (typeof data.token !== 'string' || data.token.length === 0) return false;
    if (!['TOKEN_BATCH', 'STREAM_COMPLETE', 'HEALTH_BROKEN', 'HEALTH_RECOVERED', 'MESSAGE_LIMIT_UPDATE'].includes(data.type)) return false;

    if (data.type === 'MESSAGE_LIMIT_UPDATE') {
        if (typeof data.messageLimitUtilization !== 'number') return false;
    } else if (data.type === 'HEALTH_BROKEN') {
        if (typeof data.message !== 'string') return false;
    } else if (data.type === 'HEALTH_RECOVERED') {
        if (typeof data.recoveredAt !== 'number') return false;
    } else {
        // TOKEN_BATCH and STREAM_COMPLETE
        if (typeof data.inputTokens !== 'number') return false;
        if (typeof data.outputTokens !== 'number') return false;
        if (typeof data.model !== 'string') return false;

        if (data.type === 'STREAM_COMPLETE') {
            if (data.promptLength !== undefined && typeof data.promptLength !== 'number') return false;
            if (data.hasCodeBlock !== undefined && typeof data.hasCodeBlock !== 'boolean') return false;
            if (data.isShortFollowUp !== undefined && typeof data.isShortFollowUp !== 'boolean') return false;
        }
    }

    return true;
}
