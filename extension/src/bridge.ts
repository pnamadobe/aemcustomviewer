// MAIN <-> ISOLATED messaging over DOM CustomEvents on a document attribute-negotiated channel.
// The ISOLATED world generates a nonce channel; MAIN only answers on that channel.
export const HANDSHAKE_EVENT = '__acv_hs__';

export type AuthSnapshot = { authorization: string; apiBase: string; headers: Record<string, string> };
export type BridgeMsg = { type: 'auth'; data: AuthSnapshot } | { type: 'request-auth' };

export function randomChannel(): string {
  return '__acv_' + crypto.getRandomValues(new Uint32Array(4)).join('');
}
