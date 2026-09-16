/**
 * Feishu/Lark one-click app registration — a faithful port of the official
 * Node SDK's `lark.registerApp()` (`scene/registration`) onto the existing
 * `connectorsHttpRequest` bridge, so no `@larksuiteoapi/node-sdk` dependency
 * is added.
 *
 * Protocol (RFC 8628 device authorization against the accounts host):
 *
 *   POST {accountsBase}/oauth/v1/app/registration
 *   Content-Type: application/x-www-form-urlencoded
 *     action=begin&archetype=PersonalAgent&auth_method=client_secret
 *     &request_user_info=open_id
 *   → {device_code, verification_uri_complete, interval, expires_in}
 *
 *   Confirm URL = verification_uri_complete + tracking params + appPreset
 *   (avatar×N / name / desc) + addons (JSON → gzip → base64url) + createOnly.
 *   The user opens it in a browser, confirms the app in Feishu, and the
 *   appPreset values land pre-filled on that confirm page.
 *
 *   POST {accountsBase}/oauth/v1/app/registration
 *     action=poll&device_code=…
 *   → {client_id, client_secret, user_info} on success, or {error} where the
 *   RFC 8628 codes apply: `authorization_pending` (keep polling), `slow_down`
 *   (+5s interval), `access_denied` / `expired_token` (terminal). A response
 *   carrying `user_info.tenant_brand === "lark"` mid-flow means the user is a
 *   Lark-suite tenant — the SDK then continues polling against
 *   accounts.larksuite.com, and so do we (once).
 */

import { gzipSync, strToU8 } from "fflate"

import {
  connectorsHttpRequest,
  type TauriHttpRequest,
  type TauriHttpResponse,
} from "@/lib/connectors/tauri/commands"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const LARK_REGISTRATION_ENDPOINT = "/oauth/v1/app/registration"
export const LARK_ACCOUNTS_BASE_FEISHU = "https://accounts.feishu.cn"
export const LARK_ACCOUNTS_BASE_LARK = "https://accounts.larksuite.com"

/** Polling defaults when the begin response omits them. */
const DEFAULT_INTERVAL_SEC = 5
const DEFAULT_EXPIRES_SEC = 600
/** Per-request HTTP timeout for begin/poll calls. */
const REQUEST_TIMEOUT_MS = 10_000
/** RFC 8628 `slow_down` penalty: +5 seconds onto the poll interval. */
const SLOW_DOWN_PENALTY_SEC = 5
/** Maximum avatar URLs the confirm page accepts (platform limit). */
export const LARK_APP_PRESET_AVATAR_MAX = 6

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** `appPreset` — pre-filled identity on the app-creation confirm page. */
export interface LarkAppPreset {
  /**
   * 1–6 publicly reachable image URLs (png/jpg/jpeg/webp/gif); the first is
   * selected by default on the confirm page. NOT a Feishu `image_key` — the
   * platform fetches the URL server-side at creation time.
   */
  avatar?: string | string[]
  name?: string
  desc?: string
}

/** `addons` — capability manifest applied to the freshly created app. */
export interface LarkAppAddons {
  /** `false` = minimal base template with zero preset increments. */
  preset?: boolean
  scopes?: {
    tenant?: string[]
    user?: string[]
  }
  events?: {
    items?: {
      tenant?: string[]
      user?: string[]
    }
  }
  callbacks?: {
    items?: string[]
  }
}

export interface LarkAppRegistrationOptions {
  appPreset?: LarkAppPreset
  addons?: LarkAppAddons
  /** `true` creates a brand-new app; `appId` instead targets an existing one. */
  createOnly?: boolean
  /** Existing app id for the update flow. */
  appId?: string
  /** Caller attribution folded into the `source` tracking param. */
  source?: string
  signal?: AbortSignal
  /** Fires once the confirm URL is built — the caller opens/displays it. */
  onVerificationUrl?: (url: string) => void
  /** Fires on every poll-loop status transition. */
  onStatusChange?: (status: LarkAppRegistrationStatus) => void
}

export type LarkAppRegistrationStatus = "begin" | "awaiting_user" | "slowed_down" | "polling"

export interface LarkAppRegistrationResult {
  clientId: string
  clientSecret: string
  userInfo?: Record<string, unknown>
}

export type LarkAppRegistrationErrorCode =
  "begin_failed" | "access_denied" | "expired_token" | "abort" | "invalid_response" | string

export class LarkAppRegistrationError extends Error {
  readonly code: LarkAppRegistrationErrorCode

  constructor(code: LarkAppRegistrationErrorCode, description: string) {
    super(description)
    this.name = "LarkAppRegistrationError"
    this.code = code
  }
}

/** Injectable seams — production defaults hit the real bridge + clock. */
export interface LarkAppRegistrationDeps {
  request?: (req: TauriHttpRequest) => Promise<TauriHttpResponse>
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  now?: () => number
}

interface BeginResponse {
  deviceCode: string
  verificationUriComplete: string
  verificationUri?: string
  userCode?: string
  intervalSec: number
  expiresInSec: number
}

type PollOutcome =
  | { kind: "pending" }
  | { kind: "slow_down" }
  | { kind: "success"; result: LarkAppRegistrationResult; tenantBrand?: string }
  | { kind: "continue" }
  | { kind: "error"; code: string; description: string }

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function registrationUrl(accountsBase: string): string {
  return `${accountsBase}${LARK_REGISTRATION_ENDPOINT}`
}

async function postForm(
  request: NonNullable<LarkAppRegistrationDeps["request"]>,
  accountsBase: string,
  params: Record<string, string>
): Promise<Record<string, unknown>> {
  const resp = await request({
    url: registrationUrl(accountsBase),
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
    timeoutMs: REQUEST_TIMEOUT_MS,
  })
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(resp.body) as Record<string, unknown>
  } catch {
    throw new LarkAppRegistrationError(
      "invalid_response",
      `registration endpoint returned non-JSON (HTTP ${resp.status})`
    )
  }
  return parsed
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

// ---------------------------------------------------------------------------
// Begin
// ---------------------------------------------------------------------------

export async function beginLarkAppRegistration(
  deps: LarkAppRegistrationDeps = {}
): Promise<BeginResponse> {
  const request = deps.request ?? connectorsHttpRequest
  const parsed = await postForm(request, LARK_ACCOUNTS_BASE_FEISHU, {
    action: "begin",
    archetype: "PersonalAgent",
    auth_method: "client_secret",
    request_user_info: "open_id",
  }).catch((err) => {
    if (err instanceof LarkAppRegistrationError) throw err
    throw new LarkAppRegistrationError(
      "begin_failed",
      err instanceof Error ? err.message : String(err)
    )
  })
  // `begin` is the only leg where a bare transport/HTTP failure is fatal on
  // the spot; a well-formed `{error}` in a 4xx body still lands below.
  if (typeof parsed.error === "string" && parsed.error) {
    throw new LarkAppRegistrationError(
      parsed.error,
      asString(parsed.error_description) ?? parsed.error
    )
  }
  const deviceCode = asString(parsed.device_code)
  const verificationUriComplete = asString(parsed.verification_uri_complete)
  if (!deviceCode || !verificationUriComplete) {
    throw new LarkAppRegistrationError(
      "invalid_response",
      "begin response is missing device_code or verification_uri_complete"
    )
  }
  return {
    deviceCode,
    verificationUriComplete,
    verificationUri: asString(parsed.verification_uri),
    userCode: asString(parsed.user_code),
    intervalSec: Math.max(1, asNumber(parsed.interval) ?? DEFAULT_INTERVAL_SEC),
    expiresInSec: Math.max(1, asNumber(parsed.expires_in) ?? DEFAULT_EXPIRES_SEC),
  }
}

// ---------------------------------------------------------------------------
// Confirm URL — appPreset / addons / createOnly land as query params
// ---------------------------------------------------------------------------

function normalizeAvatarList(avatar: string | string[] | undefined): string[] {
  const list = typeof avatar === "string" ? [avatar] : (avatar ?? [])
  if (list.length > LARK_APP_PRESET_AVATAR_MAX) {
    throw new LarkAppRegistrationError(
      "invalid_preset",
      `appPreset.avatar accepts at most ${LARK_APP_PRESET_AVATAR_MAX} URLs`
    )
  }
  for (const item of list) {
    if (!/^https?:\/\//i.test(item)) {
      throw new LarkAppRegistrationError(
        "invalid_preset",
        "appPreset.avatar must be publicly reachable http(s) image URLs"
      )
    }
  }
  return list
}

/**
 * `addons` wire encoding — fixed by the platform, identical to the official
 * SDK: `JSON.stringify(whitelist-normalized) → gzip → base64 → URL-safe`.
 * The confirm page silently drops the whole payload on any shape mismatch,
 * so unknown keys / malformed values throw here instead.
 */
export function encodeLarkAppAddons(addons: LarkAppAddons): string {
  const normalized = normalizeAddons(addons)
  const gzipped = gzipSync(strToU8(JSON.stringify(normalized)))
  let binary = ""
  const CHUNK = 0x8000
  for (let i = 0; i < gzipped.length; i += CHUNK) {
    binary += String.fromCharCode(...gzipped.subarray(i, i + CHUNK))
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function assertPlainObject(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LarkAppRegistrationError("invalid_addons", `${path} must be an object`)
  }
}

function assertAllowedKeys(obj: Record<string, unknown>, allowed: string[], path: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw new LarkAppRegistrationError(
        "invalid_addons",
        `${path}.${key} is not allowed; allowed keys: ${allowed.join(", ")}`
      )
    }
  }
}

function validateStringArray(value: unknown, path: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    throw new LarkAppRegistrationError("invalid_addons", `${path} must be an array of strings`)
  }
  value.forEach((item, idx) => {
    if (typeof item !== "string" || item === "") {
      throw new LarkAppRegistrationError(
        "invalid_addons",
        `${path}[${idx}] must be a non-empty string`
      )
    }
  })
  return value
}

function normalizeAddons(addons: LarkAppAddons): LarkAppAddons {
  assertPlainObject(addons, "addons")
  assertAllowedKeys(addons, ["preset", "scopes", "events", "callbacks"], "addons")

  let itemCount = 0
  const pick = (value: unknown, path: string): string[] | undefined => {
    const items = validateStringArray(value, path)
    itemCount += items?.length ?? 0
    return items
  }

  const normalized: LarkAppAddons = {}

  if (addons.preset !== undefined) {
    if (typeof addons.preset !== "boolean") {
      throw new LarkAppRegistrationError("invalid_addons", "addons.preset must be a boolean")
    }
    normalized.preset = addons.preset
  }

  if (addons.scopes !== undefined) {
    assertPlainObject(addons.scopes, "addons.scopes")
    assertAllowedKeys(addons.scopes, ["tenant", "user"], "addons.scopes")
    normalized.scopes = {
      tenant: pick(addons.scopes.tenant, "addons.scopes.tenant"),
      user: pick(addons.scopes.user, "addons.scopes.user"),
    }
  }

  if (addons.events !== undefined) {
    assertPlainObject(addons.events, "addons.events")
    assertAllowedKeys(addons.events, ["items"], "addons.events")
    if (addons.events.items !== undefined) {
      assertPlainObject(addons.events.items, "addons.events.items")
      assertAllowedKeys(addons.events.items, ["tenant", "user"], "addons.events.items")
      normalized.events = {
        items: {
          tenant: pick(addons.events.items.tenant, "addons.events.items.tenant"),
          user: pick(addons.events.items.user, "addons.events.items.user"),
        },
      }
    }
  }

  if (addons.callbacks !== undefined) {
    assertPlainObject(addons.callbacks, "addons.callbacks")
    assertAllowedKeys(addons.callbacks, ["items"], "addons.callbacks")
    normalized.callbacks = {
      items: pick(addons.callbacks.items, "addons.callbacks.items"),
    }
  }

  // An all-empty addons is treated as "no addons" by the confirm page — the
  // one exception is `preset: false`, which is a meaningful payload on its
  // own (minimal base template, zero increments).
  if (itemCount === 0 && addons.preset !== false) {
    throw new LarkAppRegistrationError(
      "invalid_addons",
      "addons must contain at least one scope, event or callback"
    )
  }
  return normalized
}

export interface BuildConfirmUrlInput {
  verificationUriComplete: string
  appPreset?: LarkAppPreset
  addons?: LarkAppAddons
  createOnly?: boolean
  appId?: string
  source?: string
}

export function buildLarkRegistrationConfirmUrl(input: BuildConfirmUrlInput): string {
  const url = new URL(input.verificationUriComplete)
  url.searchParams.append("from", "cognia")
  url.searchParams.append("source", input.source ? `cognia/${input.source}` : "cognia")
  url.searchParams.append("tp", "cognia")
  for (const avatar of normalizeAvatarList(input.appPreset?.avatar)) {
    url.searchParams.append("avatar", avatar)
  }
  if (input.appPreset?.name?.trim()) {
    url.searchParams.append("name", input.appPreset.name.trim())
  }
  if (input.appPreset?.desc?.trim()) {
    url.searchParams.append("desc", input.appPreset.desc.trim())
  }
  if (input.addons) {
    url.searchParams.append("addons", encodeLarkAppAddons(input.addons))
  }
  if (input.createOnly) {
    url.searchParams.append("createOnly", "true")
  }
  if (input.appId?.trim()) {
    url.searchParams.append("clientID", input.appId.trim())
  }
  return url.toString()
}

// ---------------------------------------------------------------------------
// Poll
// ---------------------------------------------------------------------------

async function pollLarkAppRegistration(
  request: NonNullable<LarkAppRegistrationDeps["request"]>,
  accountsBase: string,
  deviceCode: string
): Promise<PollOutcome> {
  const parsed = await postForm(request, accountsBase, {
    action: "poll",
    device_code: deviceCode,
  }).catch((err) => {
    if (err instanceof LarkAppRegistrationError) {
      return { kind: "error" as const, code: err.code, description: err.message }
    }
    return {
      kind: "error" as const,
      code: "request_failed",
      description: err instanceof Error ? err.message : String(err),
    }
  })
  if ("kind" in parsed) return parsed as PollOutcome

  const clientId = asString(parsed.client_id)
  const clientSecret = asString(parsed.client_secret)
  if (clientId && clientSecret) {
    const userInfo =
      typeof parsed.user_info === "object" && parsed.user_info !== null
        ? (parsed.user_info as Record<string, unknown>)
        : undefined
    return {
      kind: "success",
      result: { clientId, clientSecret, userInfo },
      tenantBrand: asString(userInfo?.tenant_brand),
    }
  }

  const error = asString(parsed.error)
  if (error === "authorization_pending") return { kind: "pending" }
  if (error === "slow_down") return { kind: "slow_down" }
  if (error) {
    return {
      kind: "error",
      code: error,
      description: asString(parsed.error_description) ?? error,
    }
  }

  // Any non-error response mid-flow keeps the loop going (e.g. a partial
  // response carrying only user_info while authorization is still pending).
  return { kind: "continue" }
}

// ---------------------------------------------------------------------------
// Full loop — begin → confirm URL → poll until success / terminal error
// ---------------------------------------------------------------------------

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new LarkAppRegistrationError("abort", "registration cancelled"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

export async function registerLarkApp(
  options: LarkAppRegistrationOptions = {},
  deps: LarkAppRegistrationDeps = {}
): Promise<LarkAppRegistrationResult> {
  const request = deps.request ?? connectorsHttpRequest
  const sleep = deps.sleep ?? defaultSleep
  const now = deps.now ?? (() => Date.now())
  const signal = options.signal

  const throwIfAborted = () => {
    if (signal?.aborted) {
      throw new LarkAppRegistrationError("abort", "registration cancelled")
    }
  }

  throwIfAborted()
  options.onStatusChange?.("begin")
  const begun = await beginLarkAppRegistration({ request })

  const confirmUrl = buildLarkRegistrationConfirmUrl({
    verificationUriComplete: begun.verificationUriComplete,
    appPreset: options.appPreset,
    addons: options.addons,
    createOnly: options.createOnly,
    appId: options.appId,
    source: options.source,
  })
  options.onVerificationUrl?.(confirmUrl)
  options.onStatusChange?.("awaiting_user")

  const deadline = now() + begun.expiresInSec * 1000
  let intervalSec = begun.intervalSec
  let accountsBase = LARK_ACCOUNTS_BASE_FEISHU
  let switchedToLark = false

  for (;;) {
    throwIfAborted()
    if (now() >= deadline) {
      throw new LarkAppRegistrationError(
        "expired_token",
        "the verification link expired before the app was confirmed"
      )
    }
    await sleep(intervalSec * 1000, signal)
    throwIfAborted()
    if (now() >= deadline) {
      throw new LarkAppRegistrationError(
        "expired_token",
        "the verification link expired before the app was confirmed"
      )
    }
    options.onStatusChange?.("polling")
    const outcome = await pollLarkAppRegistration(request, accountsBase, begun.deviceCode)
    switch (outcome.kind) {
      case "pending":
        continue
      case "slow_down":
        intervalSec += SLOW_DOWN_PENALTY_SEC
        options.onStatusChange?.("slowed_down")
        continue
      case "continue":
        continue
      case "success": {
        // A Lark-suite tenant answers on the Feishu domain but must finish on
        // the Lark domain — the SDK re-polls there once before accepting the
        // credentials, and we mirror that.
        if (outcome.tenantBrand === "lark" && !switchedToLark) {
          switchedToLark = true
          accountsBase = LARK_ACCOUNTS_BASE_LARK
          continue
        }
        return outcome.result
      }
      case "error":
        throw new LarkAppRegistrationError(outcome.code, outcome.description)
    }
  }
}
