/**
 * RFC 8628 device-code login.
 *
 * The redirect flow in `oauth.ts` needs a browser that can come back to us. A
 * device-code login does not: the user is shown a short code and a URL, they
 * finish in whatever browser they like, and the client polls until the
 * provider says they are done. Several providers publish only this flow,
 * GitHub among them, so without it those logins cannot be offered at all.
 *
 * The polling loop is the part worth being careful about. A device-code
 * endpoint is unauthenticated and is polled in a tight loop by definition, so
 * it is the easiest place in the whole login surface to build an accidental
 * request flood. Four things bound it:
 *
 *   * the provider's own `interval`, floored so a bad value cannot busy-loop,
 *   * `slow_down`, which widens the interval for the rest of the flow as the
 *     RFC requires rather than being retried at the same cadence,
 *   * the provider's `expires_in` deadline, and
 *   * a hard attempt cap, so a provider that answers `authorization_pending`
 *     forever still terminates.
 */

import {
  getAllProviders,
  type OAuthDeviceCodeConfig,
  type OAuthRuleValue,
} from "@cognia/provider-types"

import { getProviderCoreLogger, proxyFetch } from "./runtime-adapters"
import { describeOAuthError, isFormEncoded, type OAuthCredential } from "./oauth"

const log = getProviderCoreLogger("ai")

/** RFC 8628's default when a provider states no interval. */
export const DEFAULT_DEVICE_POLL_INTERVAL_SECONDS = 5
/** Floor on the poll cadence, so a hostile or zero interval cannot busy-loop. */
export const MIN_DEVICE_POLL_INTERVAL_MS = 1_000
/** Added to the interval on each `slow_down`, per RFC 8628. */
export const SLOW_DOWN_INCREMENT_MS = 5_000
/** Terminates a provider that answers `authorization_pending` forever. */
export const MAX_DEVICE_POLL_ATTEMPTS = 180
/** Used when a provider states no `expires_in`. */
export const DEFAULT_DEVICE_CODE_TTL_SECONDS = 900

export interface DeviceCodeGrant {
  /** Secret the client polls with. Never shown to the user. */
  deviceCode: string
  /** Short code the user types into the verification page. */
  userCode: string
  /** Page the user opens to enter the code. */
  verificationUri: string
  /** Verification page with the code pre-filled, when the provider offers one. */
  verificationUriComplete?: string
  intervalSeconds: number
  expiresInSeconds: number
}

export type DeviceCodePoll =
  | { status: "complete"; credential: OAuthCredential }
  | { status: "pending" }
  | { status: "slow_down" }
  | { status: "failed"; message: string }

function deviceConfigFor(providerId: string): {
  device: OAuthDeviceCodeConfig
  tokenUrl: string
  clientId?: string
} | null {
  const provider = getAllProviders()[providerId]
  const oauth = provider?.oauthConfig
  if (!provider?.supportsOAuth || !oauth?.deviceCode) return null
  return { device: oauth.deviceCode, tokenUrl: oauth.tokenUrl, clientId: oauth.clientId }
}

/** True when this provider publishes a device-code login. */
export function supportsDeviceCodeLogin(providerId: string): boolean {
  return deviceConfigFor(providerId) !== null
}

function literalRecord(rules: Record<string, OAuthRuleValue> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, rule] of Object.entries(rules ?? {})) {
    if ("literal" in rule && rule.literal != null) out[key] = String(rule.literal)
  }
  return out
}

function readPath(body: unknown, path: string | undefined, fallback: string): unknown {
  const segments = (path ?? fallback).split(".")
  return segments.reduce<unknown>((current, segment) => {
    if (current == null || typeof current !== "object") return undefined
    return (current as Record<string, unknown>)[segment]
  }, body)
}

function asPositiveNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

/**
 * Ask the provider for a device code. The returned `userCode` and
 * `verificationUri` are what the UI shows.
 */
export async function startDeviceCodeLogin(providerId: string): Promise<DeviceCodeGrant | null> {
  const resolved = deviceConfigFor(providerId)
  if (!resolved) return null
  const { device, clientId } = resolved

  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...literalRecord(device.headers),
  }
  const body: Record<string, string> = { ...literalRecord(device.deviceCodeParams) }
  if (clientId) body.client_id = clientId
  if (device.scope) body.scope = device.scope

  const response = await proxyFetch(device.deviceCodeUrl, {
    method: "POST",
    headers,
    body: isFormEncoded(headers) ? new URLSearchParams(body).toString() : JSON.stringify(body),
  })
  const parsed = await readJson(response)
  if (!response.ok) {
    throw new Error(`${response.status}: ${describeOAuthError(parsed)}`)
  }

  const map = device.deviceCodeResponse
  const deviceCode = readPath(parsed, map?.deviceCode, "device_code")
  const userCode = readPath(parsed, map?.userCode, "user_code")
  const verificationUri = readPath(parsed, map?.verificationUri, "verification_uri")
  if (typeof deviceCode !== "string" || typeof userCode !== "string") return null

  const complete = readPath(parsed, map?.verificationUriComplete, "verification_uri_complete")
  return {
    deviceCode,
    userCode,
    verificationUri: typeof verificationUri === "string" ? verificationUri : "",
    verificationUriComplete: typeof complete === "string" ? complete : undefined,
    intervalSeconds: asPositiveNumber(
      readPath(parsed, map?.intervalSeconds, "interval"),
      DEFAULT_DEVICE_POLL_INTERVAL_SECONDS
    ),
    expiresInSeconds: asPositiveNumber(
      readPath(parsed, map?.expiresInSeconds, "expires_in"),
      DEFAULT_DEVICE_CODE_TTL_SECONDS
    ),
  }
}

/**
 * Poll once and classify the answer.
 *
 * RFC 8628 puts the interesting outcomes in a 4xx body rather than in the
 * status, so a non-OK response is read before it is treated as a failure:
 * `authorization_pending` and `slow_down` are the normal path, not errors.
 */
export async function pollDeviceCodeOnce(
  providerId: string,
  deviceCode: string
): Promise<DeviceCodePoll> {
  const resolved = deviceConfigFor(providerId)
  if (!resolved) return { status: "failed", message: "provider has no device-code login" }
  const { device, tokenUrl, clientId } = resolved

  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...literalRecord(device.headers),
  }
  const body: Record<string, string> = {
    device_code: deviceCode,
    grant_type: device.grantType ?? "urn:ietf:params:oauth:grant-type:device_code",
  }
  if (clientId) body.client_id = clientId

  let parsed: unknown
  try {
    const response = await proxyFetch(device.pollUrl ?? tokenUrl, {
      method: "POST",
      headers,
      body: isFormEncoded(headers) ? new URLSearchParams(body).toString() : JSON.stringify(body),
    })
    parsed = await readJson(response)
  } catch (error) {
    // A dropped connection mid-flow is not the user declining. Treat it as
    // pending so the loop's own deadline decides when to give up.
    log.warn("device-code poll failed", { providerId, error: String(error) })
    return { status: "pending" }
  }

  const record = (parsed ?? {}) as { error?: string; access_token?: string; expires_in?: number }
  switch (record.error) {
    case "authorization_pending":
      return { status: "pending" }
    case "slow_down":
      return { status: "slow_down" }
    case undefined:
      break
    default:
      return { status: "failed", message: describeOAuthError(parsed) }
  }

  const accessToken = record.access_token
  if (typeof accessToken !== "string" || !accessToken) {
    return { status: "pending" }
  }
  return {
    status: "complete",
    credential: {
      apiKey: accessToken,
      refreshToken: (parsed as { refresh_token?: string }).refresh_token,
      expiresAt:
        typeof record.expires_in === "number" ? Date.now() + record.expires_in * 1000 : undefined,
    },
  }
}

export interface DeviceCodeLoopOptions {
  grant: DeviceCodeGrant
  signal?: AbortSignal
  /** Injected in tests. Defaults to a real timer. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  now?: () => number
  /** Injected in tests. Defaults to {@link pollDeviceCodeOnce}. */
  poll?: (providerId: string, deviceCode: string) => Promise<DeviceCodePoll>
}

export type DeviceCodeOutcome =
  | { status: "complete"; credential: OAuthCredential }
  | { status: "cancelled" }
  | { status: "expired" }
  | { status: "failed"; message: string }

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/**
 * Poll until the user finishes, declines, the code expires, or the caller
 * cancels. Never throws for an expected outcome, so the UI can render each one
 * differently instead of showing a stack trace.
 */
export async function runDeviceCodeLogin(
  providerId: string,
  options: DeviceCodeLoopOptions
): Promise<DeviceCodeOutcome> {
  const { grant } = options
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? defaultSleep
  const poll = options.poll ?? pollDeviceCodeOnce

  const deadline = now() + grant.expiresInSeconds * 1000
  let intervalMs = Math.max(MIN_DEVICE_POLL_INTERVAL_MS, grant.intervalSeconds * 1000)

  for (let attempt = 0; attempt < MAX_DEVICE_POLL_ATTEMPTS; attempt++) {
    if (options.signal?.aborted) return { status: "cancelled" }
    if (now() >= deadline) return { status: "expired" }

    const result = await poll(providerId, grant.deviceCode)
    if (result.status === "complete") return { status: "complete", credential: result.credential }
    if (result.status === "failed") return { status: "failed", message: result.message }
    if (result.status === "slow_down") {
      // The RFC widens the interval for the REST of the flow, not just for the
      // next attempt. Retrying at the old cadence is what the provider is
      // objecting to.
      intervalMs += SLOW_DOWN_INCREMENT_MS
    }

    const remaining = deadline - now()
    if (remaining <= 0) return { status: "expired" }
    await sleep(Math.min(intervalMs, remaining), options.signal)
    if (options.signal?.aborted) return { status: "cancelled" }
  }

  return { status: "expired" }
}
