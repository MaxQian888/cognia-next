/**
 * Guided paste-a-key login.
 *
 * Most providers publish no OAuth client at all. Their sanctioned flow is
 * "open the console, mint a key, paste it back", and that is what the coding
 * plans from Zhipu, Moonshot and Alibaba expect. Today cognia renders those as
 * a bare text field with no idea where the key comes from and no check that
 * the pasted value works.
 *
 * This turns that into a real login: the provider says which page to open,
 * what a key looks like, and the cheapest call that proves one is accepted.
 *
 * The three-way result is the point. "I could not verify this key" is a
 * different answer from "this key is wrong", and collapsing them would either
 * block a working key when the user is offline, or accept a typo silently and
 * surface it later as an unexplained chat failure.
 */

import {
  getAllProviders,
  type ApiKeyAuthHeader,
  type ApiKeyLoginConfig,
  type ApiKeyValidation,
  type ProviderConfig,
} from "@cognia/provider-types"

import { getProviderCoreLogger, proxyFetch } from "./runtime-adapters"

const log = getProviderCoreLogger("ai")

/** How long a validation probe may take before we stop waiting on it. */
export const KEY_VALIDATION_TIMEOUT_MS = 15_000

export type ApiKeyValidationResult =
  /** The provider accepted the key. */
  | { status: "valid" }
  /** The provider rejected the key itself. Do not save it. */
  | { status: "invalid"; message: string }
  /**
   * The probe could not answer: offline, throttled, or the provider returned
   * something unrelated to the key. The key may well be fine, so the caller
   * saves it and says it is unverified rather than refusing it.
   */
  | { status: "unverified"; message: string }

/** The provider's guided-key login spec exactly as declared, with nothing derived. */
export function getKeyLoginConfig(providerId: string): ApiKeyLoginConfig | null {
  return getAllProviders()[providerId]?.keyLogin ?? null
}

/**
 * Where the "open the console" link came from, most specific first. The UI
 * words the button differently for a page that mints keys and a page that
 * merely leads to one, so this is part of the answer, not debug information.
 */
export type KeyLoginAuthUrlSource =
  /** The provider declared the page outright. */
  | "declared"
  /** The provider's own console. */
  | "dashboard"
  /** The console of the vendor this entry is a deployment of. */
  | "relay"
  /** The vendor's platform page, when nothing more precise exists. */
  | "website"

/** A guided key login with every gap filled in from the provider's own catalog entry. */
export interface ResolvedKeyLogin extends ApiKeyLoginConfig {
  authUrl?: string
  authUrlSource?: KeyLoginAuthUrlSource
  validate?: ApiKeyValidation
  /**
   * Tried only when the first probe turns out not to exist at all. Anthropic
   * publishes `GET /v1/models`, but the relays that borrow its wire format
   * mostly implement only `/messages`, so the derived probe 404s and the
   * check can never reach a verdict without a second shape to fall back on.
   */
  fallbackValidate?: ApiKeyValidation
}

function authHeaderFor(provider: ProviderConfig): ApiKeyAuthHeader {
  switch (provider.protocol) {
    case "anthropic":
      return "x-api-key"
    case "gemini":
      return "x-goog-api-key"
    default:
      return "bearer"
  }
}

/**
 * Derive a probe from what the catalog already knows.
 *
 * Almost every entry carries `defaultBaseURL` and a protocol, and every
 * OpenAI-compatible and Anthropic-compatible API answers `GET /models`. That
 * is the ideal probe: it proves the key is accepted and spends no tokens
 * doing it. A provider whose model list is missing or shaped differently
 * answers `unverified` rather than `invalid`, so a derived probe that does not
 * fit can never reject a working key.
 */
function deriveValidation(provider: ProviderConfig): ApiKeyValidation | undefined {
  const base = provider.defaultBaseURL?.trim()
  if (!base) return undefined
  if (provider.protocol === "bedrock") return undefined
  return {
    kind: "models-endpoint",
    url: `${base.replace(/\/+$/, "")}/models`,
    auth: authHeaderFor(provider),
  }
}

/**
 * The probe to try when the derived one turns out not to be implemented.
 *
 * Only Anthropic-wire providers need this, and only because the relays that
 * speak that wire (the Chinese coding plans above all) ship `/messages` and
 * nothing else. `/messages` costs a token, which is why it is never the first
 * choice, and why it runs only after the free probe has answered "no such
 * endpoint" rather than any kind of verdict about the key.
 */
function deriveFallbackValidation(provider: ProviderConfig): ApiKeyValidation | undefined {
  if (provider.protocol !== "anthropic") return undefined
  const base = provider.defaultBaseURL?.trim()
  const model = provider.defaultModel?.trim()
  if (!base || !model) return undefined
  return { kind: "anthropic-messages", baseUrl: base.replace(/\/+$/, ""), model }
}

/**
 * The page to send the user to for a key.
 *
 * A relay entry is a deployment of a vendor, billed to that vendor's account
 * and opened with that vendor's key, so when it names no console of its own
 * the vendor's console is the right answer rather than a guess. Falling back
 * to `website` last keeps every provider reachable: a vendor's platform page
 * is a weaker answer than its key page, never a wrong one.
 */
function resolveAuthUrl(
  provider: ProviderConfig,
  providers: Record<string, ProviderConfig>
): { url: string; source: KeyLoginAuthUrlSource } | null {
  const declared = provider.keyLogin?.authUrl?.trim()
  if (declared) return { url: declared, source: "declared" }

  const dashboard = provider.dashboardUrl?.trim()
  if (dashboard) return { url: dashboard, source: "dashboard" }

  const vendorDashboard = provider.relayOf
    ? providers[provider.relayOf]?.dashboardUrl?.trim()
    : undefined
  if (vendorDashboard) return { url: vendorDashboard, source: "relay" }

  const website = provider.website?.trim()
  if (website) return { url: website, source: "website" }

  return null
}

/**
 * The guided key login for a provider, declared fields first and the rest
 * derived.
 *
 * Deriving matters more than the handful of explicit entries: the catalog
 * holds 79 providers, and hand-writing a login for each would leave most of
 * them as the bare, unlabelled key box they are today. `dashboardUrl` is
 * already the page where that provider mints keys, which is exactly what the
 * login needs to open.
 */
export function resolveKeyLogin(providerId: string): ResolvedKeyLogin | null {
  const providers = getAllProviders()
  const provider = providers[providerId]
  if (!provider || provider.apiKeyRequired === false) return null

  const declared = provider.keyLogin
  const auth = resolveAuthUrl(provider, providers)
  const validate = declared?.validate ?? deriveValidation(provider)
  // A declared probe is the provider's own word on how to check a key; second
  // guessing it with a derived fallback would spend tokens to contradict it.
  const fallbackValidate = declared?.validate ? undefined : deriveFallbackValidation(provider)
  if (!auth && !validate) return null

  return {
    ...declared,
    authUrl: auth?.url,
    authUrlSource: auth?.source,
    validate,
    fallbackValidate,
  }
}

/** True when this provider can offer a guided key login. */
export function supportsKeyLogin(providerId: string): boolean {
  return resolveKeyLogin(providerId) !== null
}

/**
 * Clean up what the user pasted. People copy the whole `Authorization` header
 * as often as they copy the key, and surrounding whitespace comes free with
 * every copy from a web console.
 */
export function normalizeApiKey(raw: string, normalize?: ApiKeyLoginConfig["normalize"]): string {
  const trimmed = raw.trim()
  if (normalize === "strip-bearer") {
    return trimmed.replace(/^Bearer\s+/i, "").trim()
  }
  return trimmed
}

function buildProbe(
  validation: ApiKeyValidation,
  apiKey: string
): { url: string; init: RequestInit } {
  switch (validation.kind) {
    case "models-endpoint": {
      const auth = validation.auth ?? "bearer"
      const headers: Record<string, string> =
        auth === "bearer"
          ? { Authorization: `Bearer ${apiKey}` }
          : auth === "x-api-key"
            ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
            : { "x-goog-api-key": apiKey }
      return { url: validation.url, init: { method: "GET", headers } }
    }
    case "chat-completions": {
      const field = validation.maxTokensField ?? "max_tokens"
      return {
        url: `${validation.baseUrl.replace(/\/+$/, "")}/chat/completions`,
        init: {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: validation.model,
            messages: [{ role: "user", content: "." }],
            [field]: 1,
          }),
        },
      }
    }
    case "anthropic-messages":
      return {
        url: `${validation.baseUrl.replace(/\/+$/, "")}/messages`,
        init: {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: validation.model,
            max_tokens: 1,
            messages: [{ role: "user", content: "." }],
          }),
        },
      }
  }
}

function messageOf(body: unknown, fallback: string): string {
  if (!body || typeof body !== "object") return fallback
  const record = body as {
    error?: string | { message?: string }
    message?: string
    msg?: string
  }
  if (record.error && typeof record.error === "object" && record.error.message) {
    return record.error.message
  }
  if (typeof record.error === "string") return record.error
  if (typeof record.message === "string") return record.message
  if (typeof record.msg === "string") return record.msg
  return fallback
}

/** A body that says the KEY is fine but the probe model is not available to it. */
function looksLikeModelDenied(status: number, message: string): boolean {
  if (status !== 403 && status !== 404 && status !== 400) return false
  return /model|not found|no access|not authorized to use|unsupported/i.test(message)
}

/** Words that name the credential itself rather than what it may reach. */
const CREDENTIAL_SUBJECT =
  /\b(api[\s_-]?keys?|apikey|tokens?|credentials?|authorization)\b|密钥|秘钥|令牌|鉴权/i

/** Words that say the named thing is not usable. */
const CREDENTIAL_FAULT =
  /\b(invalid|incorrect|expired|revoked|not\s+valid|unauthorized|missing|malformed|bad|wrong)\b|无效|错误|过期|失效|不存在|未授权/i

/**
 * A body that rejects the CREDENTIAL, as opposed to one that rejects what the
 * credential was asked to reach.
 *
 * The distinction is the whole point of the three-way verdict: "your key
 * cannot use this model" and "your key is wrong" arrive with the same status
 * code, and only one of them is a reason to refuse to save what the user
 * pasted.
 */
function looksLikeBadCredential(message: string): boolean {
  return CREDENTIAL_SUBJECT.test(message) && CREDENTIAL_FAULT.test(message)
}

interface ProbeOutcome {
  result: ApiKeyValidationResult
  /**
   * The provider answered that this endpoint is not here, which is not a
   * verdict about the key and is the one case worth asking again a different
   * way.
   */
  endpointMissing: boolean
}

async function runProbe(
  validation: ApiKeyValidation,
  apiKey: string,
  options: { signal?: AbortSignal; timeoutMs?: number }
): Promise<ProbeOutcome> {
  const probe = buildProbe(validation, apiKey)
  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? KEY_VALIDATION_TIMEOUT_MS
  )
  const onAbort = () => controller.abort()
  // A signal that aborted BEFORE this call never fires `abort` again, so the
  // listener alone would let a cancelled check go out anyway. For the
  // `anthropic-messages` fallback that is a billed token spent after the caller
  // gave up.
  if (options.signal?.aborted) controller.abort()
  else options.signal?.addEventListener("abort", onAbort, { once: true })

  try {
    const response = await proxyFetch(probe.url, { ...probe.init, signal: controller.signal })
    if (response.ok) return { result: { status: "valid" }, endpointMissing: false }

    let body: unknown = null
    try {
      body = await response.json()
    } catch {
      body = null
    }
    const message = messageOf(body, `HTTP ${response.status}`)

    // 401 is the provider saying the credential was not accepted. Nothing
    // else is definitive: a 403 means the key authenticated and then was not
    // allowed to do this particular thing, which is routine for a key that is
    // perfectly good, so it convicts only when the body names the credential.
    if (response.status === 401) {
      return { result: { status: "invalid", message }, endpointMissing: false }
    }
    if (looksLikeBadCredential(message)) {
      return { result: { status: "invalid", message }, endpointMissing: false }
    }
    if (
      validation.kind === "chat-completions" &&
      validation.tolerateModelDenied &&
      looksLikeModelDenied(response.status, message)
    ) {
      // The key works, it just cannot reach the probe model.
      return { result: { status: "valid" }, endpointMissing: false }
    }
    // A 429 means the key was recognized well enough to be rate limited, but
    // we never saw it accepted. Neither answer is honest, so say so.
    return {
      result: { status: "unverified", message },
      endpointMissing: response.status === 404 || response.status === 405,
    }
  } catch (error) {
    return {
      result: {
        status: "unverified",
        message: error instanceof Error ? error.message : String(error),
      },
      endpointMissing: false,
    }
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener("abort", onAbort)
  }
}

/**
 * Run the provider's declared probe against a pasted key.
 *
 * Returns `valid` for a provider that answered normally, `invalid` only when
 * the provider specifically rejected the credential, and `unverified` for
 * everything else. A provider with no declared probe is always `unverified`:
 * saying "valid" without having asked anyone would be a guess dressed as a
 * check.
 */
export async function validateProviderApiKey(
  providerId: string,
  apiKey: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<ApiKeyValidationResult> {
  const login = resolveKeyLogin(providerId)
  const validation = login?.validate
  if (!validation) return { status: "unverified", message: "no validation probe declared" }
  if (!apiKey.trim()) return { status: "invalid", message: "empty key" }

  const first = await runProbe(validation, apiKey, options)
  if (first.result.status === "unverified") {
    log.warn("api key validation probe was inconclusive", {
      providerId,
      message: first.result.message,
    })
  }
  if (!first.endpointMissing || !login?.fallbackValidate) return first.result

  // The free probe is simply not implemented here. Asking again in the shape
  // this provider does implement is the difference between a real answer and
  // a button that can only ever shrug.
  const second = await runProbe(login.fallbackValidate, apiKey, options)
  return second.result
}
