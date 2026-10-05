/**
 * Shared helpers for the sync Worker suites (vitest-pool-workers).
 *
 * The server never opens envelopes or sealed names, it only checks their
 * shape and addressing, so tests fill them with correctly sized bytes. Device
 * keys and signed registry entries are real (`ChainBuilder`).
 */

import { env } from "cloudflare:test"
import { SignJWT, importJWK } from "jose"

import {
  HPKE_ENC_BYTES,
  EPOCH_ENVELOPE_CT_BYTES,
  NAME_CIPHERTEXT_BYTES,
  DEVICE_PROOF_HEADER,
  bodyDigest,
  createDeviceProof,
  ecdsaSign,
  enrollRequestSigningBytes,
  expectedRecipients,
  randomBytes,
  sasCommit,
  spaceIdFor,
  transcriptHash,
  toBase64Url,
  utf8,
  type EpochEnvelope,
  type Recipient,
  type RegistryState,
  type SealedName,
  encodeHlc,
  encryptOpPayload,
  newEpochKey,
  opKey,
  signOp,
  type Op,
  type OpHeader,
  type OpPayload,
  type SasTranscript,
} from "@cognia/sync-protocol"
import {
  ChainBuilder,
  makeDevice,
  makeRecovery,
  type TestDevice,
  type TestKeyPair,
} from "@cognia/sync-protocol/testing/chain"

import type { Env } from "../src/env"
import { handleRequest } from "../src/index"

export const testEnv = env as unknown as Env & { TEST_SIGNING_JWK: string }
export const ISSUER = "https://id.test/api/auth"
export const AUDIENCE = "https://sync.cognia.cn"

export function newUserId(): string {
  return `usr_${crypto.randomUUID().replaceAll("-", "")}`
}

export interface TokenOptions {
  iss?: string
  aud?: string | string[]
  typ?: string
  clientId?: string | null
  azp?: string
  expiresIn?: number
  alg?: "ES256"
  key?: CryptoKey
}

export async function accessToken(sub: string, options: TokenOptions = {}): Promise<string> {
  const jwk = JSON.parse(testEnv.TEST_SIGNING_JWK) as JsonWebKey & { kid: string }
  const key = options.key ?? ((await importJWK(jwk, "ES256")) as CryptoKey)
  const claims: Record<string, unknown> = { scope: "openid" }
  if (options.clientId !== null) claims.client_id = options.clientId ?? "cognia-app"
  if (options.azp) claims.azp = options.azp
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "ES256", typ: options.typ ?? "at+jwt", kid: jwk.kid })
    .setSubject(sub)
    .setIssuer(options.iss ?? ISSUER)
    .setAudience(options.aud ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + (options.expiresIn ?? 600))
    .sign(key)
}

export interface CallOptions {
  body?: unknown
  /** Signs a device proof with this device's key. */
  device?: { deviceId: string; sign: CryptoKeyPair }
  /** Overrides the proof's `iat`. */
  iat?: number
  token?: string | null
  headers?: Record<string, string>
}

export class Person {
  readonly userId = newUserId()
  private tokenValue: string | null = null

  async spaceId(): Promise<string> {
    return spaceIdFor(ISSUER, this.userId)
  }

  async token(): Promise<string> {
    return (this.tokenValue ??= await accessToken(this.userId))
  }

  async call(method: string, path: string, options: CallOptions = {}): Promise<Response> {
    const body =
      options.body === undefined
        ? undefined
        : typeof options.body === "string"
          ? options.body
          : JSON.stringify(options.body)
    const headers = new Headers(options.headers)
    const token = options.token === undefined ? await this.token() : options.token
    if (token) headers.set("authorization", `Bearer ${token}`)
    if (body !== undefined) headers.set("content-type", "application/json")
    if (options.device) {
      const url = new URL(path, "https://sync.test")
      headers.set(
        DEVICE_PROOF_HEADER,
        await createDeviceProof(
          {
            v: 1,
            spaceId: await this.spaceId(),
            deviceId: options.device.deviceId,
            method: method.toUpperCase(),
            path: url.pathname + url.search,
            bodySha256: await bodyDigest(utf8(body ?? "")),
            iat: options.iat ?? Date.now(),
          },
          options.device.sign.privateKey
        )
      )
    }
    return handleRequest(
      new Request(new URL(path, "https://sync.test"), { method, headers, body }),
      testEnv
    )
  }

  // Response bodies are asserted field by field; `any` keeps those assertions terse.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async json<T = Record<string, any>>(
    method: string,
    path: string,
    options: CallOptions = {}
  ): Promise<{ status: number; body: T }> {
    const response = await this.call(method, path, options)
    return { status: response.status, body: (await response.json()) as T }
  }
}

const bytes = (length: number, fill = 4) => toBase64Url(new Uint8Array(length).fill(fill))

export function fakeEnvelope(epoch: number, recipient: Recipient): EpochEnvelope {
  return {
    epoch,
    recipient: recipient.recipient,
    recipientEncPub: recipient.encPub,
    enc: bytes(HPKE_ENC_BYTES),
    ct: bytes(EPOCH_ENVELOPE_CT_BYTES),
  }
}

export function fakeEnvelopes(state: RegistryState): EpochEnvelope[] {
  return expectedRecipients(state).map((recipient) => fakeEnvelope(state.epoch, recipient))
}

export function fakeName(recipient: string): SealedName {
  return { recipient, enc: bytes(HPKE_ENC_BYTES), ct: bytes(NAME_CIPHERTEXT_BYTES) }
}

export interface Space {
  person: Person
  chain: ChainBuilder
  first: TestDevice
  recovery: TestKeyPair
}

/** A person with a space created by its first device. */
export async function spaceWithGenesis(person = new Person()): Promise<Space> {
  const first = await makeDevice("First")
  const recovery = await makeRecovery()
  const chain = await ChainBuilder.genesis(await person.spaceId(), first, recovery)
  const response = await person.json("POST", "/v1/space/genesis", {
    body: { entry: chain.entries[0], envelopes: fakeEnvelopes(chain.state) },
  })
  if (response.status !== 201) throw new Error(`genesis failed: ${JSON.stringify(response.body)}`)
  return { person, chain, first, recovery }
}

export interface PendingDevice {
  device: TestDevice
  nonceR: Uint8Array
  commit: string
  requestId: string
}

export async function enrollBody(device: TestDevice, state: RegistryState, commit: string) {
  const body = {
    deviceId: device.deviceId,
    platform: device.platform,
    signPub: device.signPub,
    encPub: device.encPub,
    commit,
    names: Object.values(state.devices)
      .filter((d) => d.status === "active")
      .map((d) => fakeName(d.deviceId)),
  }
  const pop = toBase64Url(await ecdsaSign(device.sign.privateKey, enrollRequestSigningBytes(body)))
  return { ...body, pop }
}

/** A new device asks to join. */
export async function requestToJoin(
  space: Space,
  name = "New",
  platform: TestDevice["platform"] = "web"
): Promise<PendingDevice> {
  const device = await makeDevice(name, platform)
  const nonceR = randomBytes(32)
  const commit = await sasCommit(nonceR)
  const response = await space.person.json("POST", "/v1/enroll/requests", {
    body: await enrollBody(device, space.chain.state, commit),
  })
  if (response.status !== 201) throw new Error(`request failed: ${JSON.stringify(response.body)}`)
  return { device, nonceR, commit, requestId: response.body.requestId }
}

export function transcriptFor(
  space: Space,
  pending: PendingDevice,
  approverDeviceId: string
): SasTranscript {
  return {
    spaceId: space.chain.spaceId,
    genesisHash: space.chain.state.genesisHash,
    requestId: pending.requestId,
    deviceId: pending.device.deviceId,
    platform: pending.device.platform,
    signPub: pending.device.signPub,
    encPub: pending.device.encPub,
    commit: pending.commit,
    approverDeviceId,
  }
}

/** Runs the approval up to the reveal; returns the approver's nonce. */
export async function upToReveal(space: Space, pending: PendingDevice): Promise<Uint8Array> {
  const nonceA = randomBytes(32)
  const nonce = await space.person.json("POST", `/v1/enroll/requests/${pending.requestId}/nonce`, {
    body: { nonceA: toBase64Url(nonceA) },
    device: space.first,
  })
  if (nonce.status !== 200 || nonce.body.state !== "nonce_set")
    throw new Error(`nonce failed: ${JSON.stringify(nonce.body)}`)
  const reveal = await space.person.json(
    "POST",
    `/v1/enroll/requests/${pending.requestId}/reveal`,
    {
      body: { nonceR: toBase64Url(pending.nonceR) },
      device: pending.device,
    }
  )
  if (reveal.status !== 200 || reveal.body.state !== "revealed")
    throw new Error(`reveal failed: ${JSON.stringify(reveal.body)}`)
  return nonceA
}

export async function approve(space: Space, pending: PendingDevice) {
  const signed = await space.chain.addByApproval(space.first, pending.device, {
    requestId: pending.requestId,
    transcriptHash: await transcriptHash(transcriptFor(space, pending, space.first.deviceId)),
  })
  return space.person.json("POST", "/v1/registry", {
    body: {
      entries: [signed],
      envelopes: [
        fakeEnvelope(space.chain.epoch, {
          recipient: pending.device.deviceId,
          encPub: pending.device.encPub,
        }),
      ],
    },
    device: space.first,
  })
}

/** A space with its first device and a second one joined by approval. */
export async function twoDevices(): Promise<{ space: Space; second: PendingDevice }> {
  const space = await spaceWithGenesis()
  const second = await requestToJoin(space, "Second")
  await upToReveal(space, second)
  const approved = await approve(space, second)
  if (approved.status !== 200) throw new Error(`approval failed: ${JSON.stringify(approved.body)}`)
  return { space, second }
}

/** `count` real ops from `device`, sealed under a throwaway epoch key (the server never opens them). */
export async function sealedOps(
  spaceId: string,
  device: TestDevice,
  options: { from: number; count: number; epoch?: number; cls?: "c" | "s" }
): Promise<Op[]> {
  const key = await opKey(newEpochKey(), spaceId)
  const ops: Op[] = []
  for (let i = 0; i < options.count; i++) {
    const deviceSeq = options.from + i
    const hlc = { ms: 1_790_000_000_000 + deviceSeq, c: 0 }
    const header: OpHeader = {
      deviceId: device.deviceId,
      deviceSeq,
      hlc,
      epoch: options.epoch ?? 1,
      schemaVer: 1,
      cls: options.cls ?? "c",
    }
    const payload: OpPayload = {
      t: "sessions",
      id: `ses_${deviceSeq}`,
      k: "upsert",
      f: { title: [`Title ${deviceSeq}`, encodeHlc({ ...hlc, deviceId: device.deviceId })] },
    }
    const { nonce, ct } = await encryptOpPayload(key, spaceId, header, payload)
    ops.push(await signOp(device.sign.privateKey, spaceId, { ...header, nonce, ct }))
  }
  return ops
}
