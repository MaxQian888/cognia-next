/**
 * Identifier generation that works in every shell this SDK runs in.
 *
 * `node:crypto` confines the client to Node; `crypto.randomUUID` alone is not
 * enough either, because it is gated on a secure context and the desktop
 * WebView can be served from a custom scheme that some engines do not classify
 * as one. `getRandomValues` carries no such gate, so it backs the fallback —
 * command ids must stay unguessable, never `Math.random`.
 */
export function randomUUID(): string {
  const source = globalThis.crypto
  if (!source) throw new Error("Web Crypto is unavailable; cannot mint a command id")
  if (typeof source.randomUUID === "function") return source.randomUUID()

  const bytes = new Uint8Array(16)
  source.getRandomValues(bytes)
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex: string[] = []
  for (const byte of bytes) hex.push(byte.toString(16).padStart(2, "0"))
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-")
}
