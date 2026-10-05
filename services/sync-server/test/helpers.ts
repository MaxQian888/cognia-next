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
  toBase64Url,
  utf8,
  type EpochEnvelope,
  type Recipient,
  type RegistryState,
  type SealedName,
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
