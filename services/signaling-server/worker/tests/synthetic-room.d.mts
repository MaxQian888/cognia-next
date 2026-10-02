// Types for `synthetic-room.mjs`, so TypeScript consumers (the status probe
// core) get checked signatures without the module itself needing a build.

export type PeerRole = "desktop" | "mobile"

export declare const PROTOCOL_VERSION: 2
export declare const DEFAULT_ROOM_TTL_MS: number

export interface RoomDescriptor {
  v: 2
  roomId: string
  roomNonce: string
  desktopSigningKey: string
  mobileSigningKey: string
  notAfter: number
}

export interface RoomIdentity {
  privateKey: CryptoKey
  /** Raw uncompressed P-256 public key, base64url. */
  publicKey: string
}

export interface SyntheticRoom {
  descriptor: RoomDescriptor
  desktop: RoomIdentity
  mobile: RoomIdentity
}

export interface UnsignedProof {
  v: 2
  roomId: string
  role: PeerRole
  sessionId: string
  epoch: string
  issuedAt: number
  challenge: string
  ecdhPublicKey: string
}

export interface SubscribeProof extends UnsignedProof {
  signature: string
}

export interface SubscribeFrame {
  kind: "subscribe"
  descriptor: RoomDescriptor
  proof: SubscribeProof
}

export declare function bytesToBase64Url(bytes: Uint8Array | ArrayBuffer): string
export declare function base64UrlToBytes(value: string): Uint8Array | null
export declare function randomBase64Url(length: number): string
export declare function encodeFields(fields: ReadonlyArray<string | number>): Uint8Array
export declare function identity(): Promise<RoomIdentity>
export declare function descriptorBytes(descriptor: RoomDescriptor): Uint8Array
export declare function deriveRoomId(descriptor: RoomDescriptor): Promise<string>
export declare function createRoom(options?: {
  now?: number
  ttlMs?: number
}): Promise<SyntheticRoom>
export declare function proofBytes(proof: UnsignedProof): Uint8Array
export declare function subscribeFrame(
  room: SyntheticRoom,
  role: PeerRole,
  challenge: string,
  options?: { now?: number }
): Promise<SubscribeFrame>
export declare function verifyProof(
  descriptor: RoomDescriptor,
  proof: SubscribeProof
): Promise<boolean>
