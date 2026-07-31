import type { EnvelopeKind, PeerRole } from "./types"

const V2_CLOCK_SKEW_MS = 5 * 60 * 1000
const TEXT_ENCODER = new TextEncoder()
const BASE64URL_RE = /^[A-Za-z0-9_-]*$/

function ownedBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(bytes)
}

type CryptoProvider = {
  subtle: SubtleCrypto
  getRandomValues<T extends ArrayBufferView>(buffer: T): T
}

function cryptoProvider(): CryptoProvider {
  if (typeof globalThis.crypto === "undefined" || !globalThis.crypto.subtle) {
    throw new Error("Web Crypto Subtle API is not available")
  }
  return globalThis.crypto as CryptoProvider
}

export interface V2KeyPair {
  privateKey: CryptoKey
  publicKey: CryptoKey
  encodedPublicKey: string
}

export interface PersistableV2SigningIdentity extends V2KeyPair {
  privateKeyJwk: JsonWebKey
}

export interface RoomDescriptorV2 {
  v: 2
  roomId: string
  roomNonce: string
  desktopSigningKey: string
  mobileSigningKey: string
  notAfter: number
}

type RoomDescriptorInput = Omit<RoomDescriptorV2, "v" | "roomId">

export interface SignalingEnvelopeV2 {
  v: 2
  roomId: string
  senderRole: PeerRole
  sessionId: string
  epoch: string
  seq: number
  issuedAt: number
  kind: EnvelopeKind
  nonce: string
  ciphertext: string
  signature: string
}

export interface SubscribeProofV2 {
  v: 2
  roomId: string
  role: PeerRole
  sessionId: string
  epoch: string
  issuedAt: number
  challenge: string
  ecdhPublicKey: string
  signature: string
}

export async function generateV2SigningKeyPair(): Promise<V2KeyPair> {
  const subtle = cryptoProvider().subtle
  const generated = (await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair
  // Re-import the private key as non-extractable before returning it. The
  // public key remains exportable because it is carried in the room
  // descriptor and is not secret.
  const privatePkcs8 = await subtle.exportKey("pkcs8", generated.privateKey)
  const privateKey = await subtle.importKey(
    "pkcs8",
    privatePkcs8,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  )
  return {
    privateKey,
    publicKey: generated.publicKey,
    encodedPublicKey: await exportV2PublicKey(generated.publicKey),
  }
}

export async function generatePersistableV2SigningIdentity(): Promise<PersistableV2SigningIdentity> {
  const subtle = cryptoProvider().subtle
  const generated = (await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair
  const privateKeyJwk = await subtle.exportKey("jwk", generated.privateKey)
  return {
    privateKey: await importV2SigningPrivateKey(privateKeyJwk),
    publicKey: generated.publicKey,
    encodedPublicKey: await exportV2PublicKey(generated.publicKey),
    privateKeyJwk,
  }
}

export async function importV2SigningPrivateKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return cryptoProvider().subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  )
}

export async function generateV2EcdhKeyPair(): Promise<V2KeyPair> {
  const subtle = cryptoProvider().subtle
  const generated = (await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair
  const privatePkcs8 = await subtle.exportKey("pkcs8", generated.privateKey)
  const privateKey = await subtle.importKey(
    "pkcs8",
    privatePkcs8,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"]
  )
  return {
    privateKey,
    publicKey: generated.publicKey,
    encodedPublicKey: await exportV2PublicKey(generated.publicKey),
  }
}

export async function exportV2PublicKey(key: CryptoKey): Promise<string> {
  const raw = await cryptoProvider().subtle.exportKey("raw", key)
  return bytesToBase64Url(new Uint8Array(raw))
}

export async function importV2SigningPublicKey(encoded: string): Promise<CryptoKey> {
  return cryptoProvider().subtle.importKey(
    "raw",
    base64UrlToBytes(encoded) as unknown as BufferSource,
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["verify"]
  )
}

export async function importV2EcdhPublicKey(encoded: string): Promise<CryptoKey> {
  return cryptoProvider().subtle.importKey(
    "raw",
    base64UrlToBytes(encoded) as unknown as BufferSource,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    []
  )
}

export async function buildRoomDescriptorV2(input: RoomDescriptorInput): Promise<RoomDescriptorV2> {
  const unsigned = {
    v: 2 as const,
    roomNonce: input.roomNonce,
    desktopSigningKey: input.desktopSigningKey,
    mobileSigningKey: input.mobileSigningKey,
    notAfter: input.notAfter,
  }
  const digest = await cryptoProvider().subtle.digest(
    "SHA-256",
    encodeFields([
      String(unsigned.v),
      unsigned.roomNonce,
      unsigned.desktopSigningKey,
      unsigned.mobileSigningKey,
      String(unsigned.notAfter),
    ]) as BufferSource
  )
  return {
    ...unsigned,
    roomId: bytesToBase64Url(new Uint8Array(digest)),
  }
}

export async function buildSubscribeProofV2(args: {
  roomId: string
  role: PeerRole
  sessionId: string
  epoch: string
  issuedAt?: number
  challenge: string
  ecdhPublicKey: string
  signingPrivateKey: CryptoKey
}): Promise<SubscribeProofV2> {
  const unsigned: Omit<SubscribeProofV2, "signature"> = {
    v: 2,
    roomId: args.roomId,
    role: args.role,
    sessionId: args.sessionId,
    epoch: args.epoch,
    issuedAt: args.issuedAt ?? Date.now(),
    challenge: args.challenge,
    ecdhPublicKey: args.ecdhPublicKey,
  }
  const signature = await cryptoProvider().subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    args.signingPrivateKey,
    encodeSubscribeProof(unsigned) as BufferSource
  )
  return {
    ...unsigned,
    signature: bytesToBase64Url(new Uint8Array(signature)),
  }
}

export async function verifySubscribeProofV2(
  descriptor: RoomDescriptorV2,
  proof: SubscribeProofV2,
  args: {
    expectedChallenge: string
    nowMs?: number
    clockSkewMs?: number
  }
): Promise<void> {
  await verifySubscribeProofCore(descriptor, proof, args.nowMs, args.clockSkewMs)
  if (proof.challenge !== args.expectedChallenge) {
    throw new Error("signaling v2 subscription challenge mismatch")
  }
}

/** Verify a peer's forwarded session proof. The peer cannot know the relay's
 * private per-socket challenge, but the challenge remains signature-bound;
 * the relay already checked equality during admission. */
export async function verifyPeerSessionProofV2(
  descriptor: RoomDescriptorV2,
  proof: SubscribeProofV2,
  args: { nowMs?: number; clockSkewMs?: number } = {}
): Promise<void> {
  await verifySubscribeProofCore(descriptor, proof, args.nowMs, args.clockSkewMs)
}

async function verifySubscribeProofCore(
  descriptor: RoomDescriptorV2,
  proof: SubscribeProofV2,
  nowMs?: number,
  clockSkewMs?: number
): Promise<void> {
  const recomputed = await buildRoomDescriptorV2({
    roomNonce: descriptor.roomNonce,
    desktopSigningKey: descriptor.desktopSigningKey,
    mobileSigningKey: descriptor.mobileSigningKey,
    notAfter: descriptor.notAfter,
  })
  if (descriptor.v !== 2 || recomputed.roomId !== descriptor.roomId) {
    throw new Error("signaling v2 room descriptor mismatch")
  }
  if (
    proof.v !== 2 ||
    proof.roomId !== descriptor.roomId ||
    !proof.sessionId ||
    !proof.epoch ||
    !proof.ecdhPublicKey
  ) {
    throw new Error("signaling v2 subscription shape")
  }
  const now = nowMs ?? Date.now()
  const clockSkew = clockSkewMs ?? V2_CLOCK_SKEW_MS
  if (Math.abs(proof.issuedAt - now) > clockSkew || descriptor.notAfter < now - clockSkew) {
    throw new Error("signaling v2 subscription expired")
  }
  const encodedSigningKey =
    proof.role === "desktop" ? descriptor.desktopSigningKey : descriptor.mobileSigningKey
  const signingPublicKey = await importV2SigningPublicKey(encodedSigningKey)
  const signature = base64UrlToBytes(proof.signature)
  const verified = await cryptoProvider().subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    signingPublicKey,
    signature as unknown as BufferSource,
    encodeSubscribeProof(proof) as BufferSource
  )
  if (!verified) {
    throw new Error("signaling v2 subscription signature verification failed")
  }
  // Parse the ephemeral key now so invalid curve points never enter the room
  // registry or get forwarded to the other peer.
  await importV2EcdhPublicKey(proof.ecdhPublicKey)
}

export async function deriveV2DirectionKey(args: {
  privateKey: CryptoKey
  peerPublicKey: CryptoKey
  roomId: string
  senderRole: PeerRole
  epoch: string
}): Promise<CryptoKey> {
  const subtle = cryptoProvider().subtle
  const sharedBits = await subtle.deriveBits(
    { name: "ECDH", public: args.peerPublicKey },
    args.privateKey,
    256
  )
  const hkdfKey = await subtle.importKey("raw", sharedBits, "HKDF", false, ["deriveKey"])
  const salt = await subtle.digest("SHA-256", TEXT_ENCODER.encode(args.roomId) as BufferSource)
  return subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt,
      info: TEXT_ENCODER.encode(
        `cognia-signaling-v2|${args.senderRole}|${args.epoch}`
      ) as BufferSource,
    },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  )
}

export async function buildV2Envelope(args: {
  roomId: string
  senderRole: PeerRole
  sessionId: string
  epoch: string
  seq: number
  issuedAt?: number
  kind: EnvelopeKind
  body: unknown
  signingPrivateKey: CryptoKey
  encryptionKey: CryptoKey
}): Promise<SignalingEnvelopeV2> {
  if (!Number.isSafeInteger(args.seq) || args.seq < 1) {
    throw new Error("signaling v2 sequence must be a positive safe integer")
  }
  const issuedAt = args.issuedAt ?? Date.now()
  const nonceBytes = await deriveNonce(args.epoch, args.senderRole, args.seq)
  const header: Omit<SignalingEnvelopeV2, "ciphertext" | "signature"> = {
    v: 2,
    roomId: args.roomId,
    senderRole: args.senderRole,
    sessionId: args.sessionId,
    epoch: args.epoch,
    seq: args.seq,
    issuedAt,
    kind: args.kind,
    nonce: bytesToBase64Url(nonceBytes),
  }
  const aad = encodeHeader(header)
  const plaintext = TEXT_ENCODER.encode(JSON.stringify(args.body))
  const nonceBuffer = ownedBytes(nonceBytes)
  const ciphertextBytes = new Uint8Array(
    await cryptoProvider().subtle.encrypt(
      { name: "AES-GCM", iv: nonceBuffer, additionalData: ownedBytes(aad) },
      args.encryptionKey,
      ownedBytes(plaintext)
    )
  )
  const signatureBytes = new Uint8Array(
    await cryptoProvider().subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      args.signingPrivateKey,
      encodeFields([...headerFields(header), ciphertextBytes]) as BufferSource
    )
  )
  return {
    ...header,
    ciphertext: bytesToBase64Url(ciphertextBytes),
    signature: bytesToBase64Url(signatureBytes),
  }
}

export async function verifyAndDecryptV2Envelope(
  raw: SignalingEnvelopeV2,
  args: {
    expectedRoomId: string
    expectedSenderRole: PeerRole
    signingPublicKey: CryptoKey
    encryptionKey: CryptoKey
    nowMs?: number
    clockSkewMs?: number
  }
): Promise<{ kind: EnvelopeKind; body: unknown }> {
  assertEnvelopeShape(raw)
  if (raw.roomId !== args.expectedRoomId) throw new Error("signaling v2 room id mismatch")
  if (raw.senderRole !== args.expectedSenderRole) {
    throw new Error("signaling v2 sender role mismatch")
  }
  const now = args.nowMs ?? Date.now()
  if (Math.abs(raw.issuedAt - now) > (args.clockSkewMs ?? V2_CLOCK_SKEW_MS)) {
    throw new Error("signaling v2 clock skew")
  }
  const header = {
    v: 2 as const,
    roomId: raw.roomId,
    senderRole: raw.senderRole,
    sessionId: raw.sessionId,
    epoch: raw.epoch,
    seq: raw.seq,
    issuedAt: raw.issuedAt,
    kind: raw.kind,
    nonce: raw.nonce,
  }
  const ciphertext = base64UrlToBytes(raw.ciphertext)
  const signature = base64UrlToBytes(raw.signature)
  const verified = await cryptoProvider().subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    args.signingPublicKey,
    signature as unknown as BufferSource,
    encodeFields([...headerFields(header), ciphertext]) as BufferSource
  )
  if (!verified) throw new Error("signaling v2 signature verification failed")
  const nonce = base64UrlToBytes(raw.nonce)
  const expectedNonce = await deriveNonce(raw.epoch, raw.senderRole, raw.seq)
  if (!constantTimeEqual(nonce, expectedNonce)) {
    throw new Error("signaling v2 nonce mismatch")
  }
  let plaintext: ArrayBuffer
  try {
    plaintext = await cryptoProvider().subtle.decrypt(
      {
        name: "AES-GCM",
        iv: ownedBytes(nonce),
        additionalData: ownedBytes(encodeHeader(header)),
      },
      args.encryptionKey,
      ownedBytes(ciphertext)
    )
  } catch {
    throw new Error("signaling v2 ciphertext authentication failed")
  }
  try {
    return {
      kind: raw.kind,
      body: JSON.parse(new TextDecoder().decode(plaintext)),
    }
  } catch {
    throw new Error("signaling v2 plaintext is not valid JSON")
  }
}

export class StrictReplayWindowV2 {
  private currentEpoch: string | null = null
  private lastSeq = 0
  private readonly retiredEpochs = new Map<string, number>()

  observe(epoch: string, seq: number, nowMs = Date.now()): boolean {
    if (!epoch || !Number.isSafeInteger(seq) || seq < 1) return false
    for (const [retired, expiresAt] of this.retiredEpochs) {
      if (expiresAt <= nowMs) this.retiredEpochs.delete(retired)
    }
    if (this.retiredEpochs.has(epoch)) return false
    if (this.currentEpoch !== epoch) {
      if (this.currentEpoch) {
        this.retiredEpochs.set(this.currentEpoch, nowMs + V2_CLOCK_SKEW_MS * 2)
      }
      this.currentEpoch = epoch
      this.lastSeq = seq
      return true
    }
    if (seq <= this.lastSeq) return false
    this.lastSeq = seq
    return true
  }
}

async function deriveNonce(epoch: string, senderRole: PeerRole, seq: number): Promise<Uint8Array> {
  const digest = await cryptoProvider().subtle.digest(
    "SHA-256",
    encodeFields([epoch, senderRole, String(seq)]) as BufferSource
  )
  return new Uint8Array(digest).slice(0, 12)
}

function headerFields(
  header: Omit<SignalingEnvelopeV2, "ciphertext" | "signature">
): Array<string | Uint8Array> {
  return [
    String(header.v),
    header.roomId,
    header.senderRole,
    header.sessionId,
    header.epoch,
    String(header.seq),
    String(header.issuedAt),
    header.kind,
    header.nonce,
  ]
}

function encodeHeader(header: Omit<SignalingEnvelopeV2, "ciphertext" | "signature">): Uint8Array {
  return encodeFields(headerFields(header))
}

function encodeSubscribeProof(
  proof: Omit<SubscribeProofV2, "signature"> | SubscribeProofV2
): Uint8Array {
  return encodeFields([
    String(proof.v),
    proof.roomId,
    proof.role,
    proof.sessionId,
    proof.epoch,
    String(proof.issuedAt),
    proof.challenge,
    proof.ecdhPublicKey,
  ])
}

function encodeFields(fields: Array<string | Uint8Array>): Uint8Array {
  const encoded = fields.map((field) =>
    typeof field === "string" ? TEXT_ENCODER.encode(field) : field
  )
  const size = encoded.reduce((total, field) => total + 4 + field.byteLength, 0)
  const output = new Uint8Array(size)
  const view = new DataView(output.buffer)
  let offset = 0
  for (const field of encoded) {
    view.setUint32(offset, field.byteLength, false)
    offset += 4
    output.set(field, offset)
    offset += field.byteLength
  }
  return output
}

function assertEnvelopeShape(value: unknown): asserts value is SignalingEnvelopeV2 {
  if (!value || typeof value !== "object") throw new Error("signaling v2 envelope shape")
  const envelope = value as Record<string, unknown>
  if (
    envelope.v !== 2 ||
    typeof envelope.roomId !== "string" ||
    (envelope.senderRole !== "desktop" && envelope.senderRole !== "mobile") ||
    typeof envelope.sessionId !== "string" ||
    typeof envelope.epoch !== "string" ||
    !Number.isSafeInteger(envelope.seq) ||
    !Number.isSafeInteger(envelope.issuedAt) ||
    typeof envelope.kind !== "string" ||
    typeof envelope.nonce !== "string" ||
    typeof envelope.ciphertext !== "string" ||
    typeof envelope.signature !== "string"
  ) {
    throw new Error("signaling v2 envelope shape")
  }
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

function base64UrlToBytes(value: string): Uint8Array {
  if (!BASE64URL_RE.test(value) || value.length % 4 === 1) {
    throw new Error("signaling v2 invalid base64url")
  }
  const padded = value + "=".repeat((4 - (value.length % 4)) % 4)
  const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"))
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  if (bytesToBase64Url(bytes) !== value) {
    throw new Error("signaling v2 non-canonical base64url")
  }
  return bytes
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index++) {
    difference |= left[index] ^ right[index]
  }
  return difference === 0
}
