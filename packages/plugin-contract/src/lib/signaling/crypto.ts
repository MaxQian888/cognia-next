/**
 * The plugin contract's share of `lib/signaling/crypto.ts`, which re-exports these.
 */
import type { SIGNALING_PROTOCOL_VERSION } from "./types"

export interface RoomDescriptor {
  v: typeof SIGNALING_PROTOCOL_VERSION
  roomId: string
  roomNonce: string
  desktopSigningKey: string
  mobileSigningKey: string
  notAfter: number
}
