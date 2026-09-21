/**
 * The opt-in LLM classifier (ADR-0188 D18, B5; ROUTE-03).
 *
 * The rules classifier labels every routed request by default. With
 * `llmClassifier.enabled`, an Auto route asks the configured router model
 * instead — once, and on these terms:
 *
 * - **Ledgered.** The call is a session-less utility run on the surface that is
 *   routing (`chat`, `gatewayRuns`, or `utilityLedger` for the absorbed
 *   difficulty judge): reserved before it leaves, settled from the provider's
 *   usage, with no hidden retries (`gate/utility-ledger.ts`).
 * - **Bounded.** The whole classification — the reservation included — has
 *   `timeoutMs` (default 1500 ms). The request carries at most 4096 input
 *   tokens (`buildClassifierPrompt` cuts the user text, never the trusted
 *   context). The reply must be strict JSON that the package schema accepts.
 * - **PII-gated.** A request `hasNoLeakingPii` objects to is never sent: a
 *   routing label is not worth a disclosure.
 *
 * Every way it can go wrong ends in the rules classifier (ROUTE-03): a timeout,
 * an invalid reply, a PII hit, a refusal (no budget, no route to the router
 * model), a fault, a provider error, no router model configured. A call that
 * went out stays booked: a reply that did not parse was settled from its usage,
 * and a call cut off by the timeout is aborted and booked UNKNOWN, its money
 * held — the ledger never assumes an unanswered call was free. The outcome says
 * which classifier labelled the request and why (`classificationReasonCodes`),
 * and the route records it in its RouteDecision.
 *
 * Successful classifications are cached in memory, per account, for
 * `cacheTtlSeconds` (default 600). The key is an HMAC — a per-account secret
 * from WebCrypto's CSPRNG, the digest by `hmacSha256Hex` so it is computed
 * synchronously — over the normalized classifier input and the classifier's
 * configuration hash, so the cache holds no request text and a key cannot be
 * guessed from one. A failure is never cached: the next request may well be
 * answered.
 */

import type { AppSettings } from "@cognia/agent-config-types"
import {
  buildClassifierInput,
  buildClassifierPrompt,
  canonicalHash,
  CLASSIFIER_INPUT_TOKEN_CAP,
  classifyWithRules,
  difficultyTierOf,
  FEATURE_VERSION,
  hmacSha256Hex,
  intakeSnapshot,
  labelsFromClassifierOutput,
  LLM_CLASSIFIER_VERSION,
  parseClassifierReply,
  ROLE_PROMPT_VERSION,
  RULES_CLASSIFIER_VERSION,
  toHex,
  type ClassifierInput,
  type ClassifierLabels,
  type ClassifierOutput,
  type DifficultyTier,
  type RoutingSnapshot,
  type RulesClassifierHints,
} from "@cognia/router-fusion"
import { normalizeRouterFusionSettings } from "@cognia/router-fusion/settings/settings"
import type { RouterFusionSurface } from "@cognia/router-fusion/settings/switches"
import { hasNoLeakingPii } from "@cognia/redact"
import type { LlmClient } from "@/lib/twin/distill/llm"

import {
  RouterFusionInfrastructureError,
  RouterFusionRefusalError,
  toInfrastructureFault,
} from "../gate/faults"
import {
  ledgeredLlmClient,
  type BeginLedgeredUtilityCallInput,
  type UtilityGrant,
} from "../gate/utility-ledger"

/** Stable feature id of the classification call, on its utility run and its request hash. */
export const CLASSIFIER_FEATURE_ID = "router-fusion-classifier"
/** The reply is a small JSON object; this bounds the reservation and the answer. */
export const CLASSIFIER_MAX_OUTPUT_TOKENS = 256
/** In-memory entries per account; the oldest goes first. */
export const CLASSIFIER_CACHE_MAX_ENTRIES = 512

export type ClassifierFallbackReason =
  /** The classification took longer than `timeoutMs`; the call was aborted. */
  | "timeout"
  /** The reply was not one JSON object. */
  | "invalid_json"
  /** The reply was JSON, but not the classification subset the schema allows. */
  | "schema_invalid"
  /** The request carries something the redaction gate objects to; nothing was sent. */
  | "pii_blocked"
  /** The ledger refused the call (budget, limits, no route to the router model). */
  | "refused"
  /** The ledger could not run (fusion database, internal exception). */
  | "infrastructure"
  /** The router model's provider failed. */
  | "provider_error"
  /** No router model is configured. */
  | "model_unset"
  /** The router model cannot be called from here (no key, a sidecar-only protocol). */
  | "model_unavailable"
  /** Nothing to classify. */
  | "empty_request"
  /** The trusted context alone exceeds the input cap, and it is never cut. */
  | "input_over_cap"

export interface ClassificationOutcome {
  /** Who labelled the request: the model, or the rules classifier standing in for it. */
  source: "llm" | "rules_fallback"
  /** The model's labels were a cached answer: no call was made. */
  cached: boolean
  labels: ClassifierLabels
  /** What the labels were read from; `truncated` becomes `context_truncated`. */
  input: ClassifierInput
  /** `classifier-1` for the model's labels, `rules-1` for a fallback. */
  classifierVersion: string
  fallback?: { reason: ClassifierFallbackReason; code?: string }
}

/**
 * The RouteDecision's record of the classification. The contract's
 * RouteDecision is strict, so the source and the fallback reason travel as
 * reason codes, next to the `classifier:<version>` code the router adds.
 */
export function classificationReasonCodes(outcome: ClassificationOutcome): string[] {
  if (outcome.source === "llm") {
    return ["classifier_source:llm", ...(outcome.cached ? ["classifier_cache:hit"] : [])]
  }
  const fallback = outcome.fallback
  return [
    "classifier_source:rules_fallback",
    ...(fallback ? [`classifier_fallback:${fallback.reason}`] : []),
    // The refusal or fault code behind a `refused` / `infrastructure` fallback.
    ...(fallback?.code ? [`classifier_fallback_code:${fallback.code}`] : []),
  ]
}

// ── cache ─────────────────────────────────────────────────────────────────────

/** The same request, whatever its spacing or Unicode composition. */
export function normalizeClassifierText(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").trim()
}

/** Everything that changes what the classifier answers, hashed. The timeout does not. */
export function classifierConfigHash(model: { providerId: string; modelId: string }): string {
  return canonicalHash({
    classifier: LLM_CLASSIFIER_VERSION,
    prompt: ROLE_PROMPT_VERSION,
    features: FEATURE_VERSION,
    tokenCap: CLASSIFIER_INPUT_TOKEN_CAP,
    deployment: `${model.providerId}::${model.modelId}`,
  })
}

interface CacheEntry {
  output: ClassifierOutput
  storedAt: number
}

/** One account's classifications. Only validated model output is ever stored. */
export class ClassifierCache {
  private readonly entries = new Map<string, CacheEntry>()

  constructor(
    private readonly secret: string,
    private readonly maxEntries: number = CLASSIFIER_CACHE_MAX_ENTRIES
  ) {}

  keyOf(normalizedText: string, configHash: string): string {
    return hmacSha256Hex(this.secret, `${configHash}\u0000${normalizedText}`)
  }

  /** A hit younger than the CURRENT ttl: shortening the TTL takes effect at once. */
  get(key: string, now: number, ttlMs: number): ClassifierOutput | null {
    const entry = this.entries.get(key)
    if (!entry) return null
    if (ttlMs <= 0 || now - entry.storedAt >= ttlMs) {
      this.entries.delete(key)
      return null
    }
    // Most recently used goes last, so eviction takes the least recently used.
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.output
  }

  set(key: string, output: ClassifierOutput, now: number, ttlMs: number): void {
    if (ttlMs <= 0) return
    this.entries.delete(key)
    this.entries.set(key, { output, storedAt: now })
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  get size(): number {
    return this.entries.size
  }
}

function newCacheSecret(): string {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  return toHex(bytes)
}

const caches = new Map<string, ClassifierCache>()

/** The cache of one account (keyed by its database), created with a fresh secret. */
export function classifierCacheFor(accountKey: string): ClassifierCache {
  let cache = caches.get(accountKey)
  if (!cache) {
    cache = new ClassifierCache(newCacheSecret())
    caches.set(accountKey, cache)
  }
  return cache
}

export function __resetClassifierCachesForTesting(): void {
  caches.clear()
}

// ── one classification ────────────────────────────────────────────────────────

export interface ClassifierCallOptions {
  system: string
  maxTokens: number
  temperature: number
  abortSignal: AbortSignal
}

export interface LlmClassifierDeps {
  /** One ledgered call to the router model, or null when none can be made. */
  call: ((prompt: string, options: ClassifierCallOptions) => Promise<string>) | null
  /** Why `call` is null. */
  unavailable?: "model_unset"
  cache: ClassifierCache | null
  configHash: string
  timeoutMs: number
  cacheTtlMs: number
  now: () => number
}

const TIMED_OUT = Symbol("classifier-timeout")

/** The router model has no client here: no renderer key, or a protocol only the sidecar runs. */
export class ClassifierModelUnavailableError extends Error {
  constructor(providerId: string, modelId: string) {
    super(`The classifier's router model ${providerId}::${modelId} cannot be called here.`)
    this.name = "ClassifierModelUnavailableError"
  }
}

function fallbackReasonOf(error: unknown): { reason: ClassifierFallbackReason; code?: string } {
  if (error instanceof ClassifierModelUnavailableError) return { reason: "model_unavailable" }
  if (error instanceof RouterFusionRefusalError) return { reason: "refused", code: error.code }
  if (error instanceof RouterFusionInfrastructureError) {
    return { reason: "infrastructure", code: error.code }
  }
  return { reason: "provider_error" }
}

/**
 * Classify one request. Never throws: the worst outcome is the rules
 * classifier's labels with the reason the model's were not used.
 */
export async function classifyWithLlm(
  deps: LlmClassifierDeps,
  snapshot: RoutingSnapshot,
  hints: RulesClassifierHints
): Promise<ClassificationOutcome> {
  // The fallback is exactly what the rules classifier reads when the LLM
  // classifier is off, so a fallback routes as if it had never been enabled.
  const rulesInput = buildClassifierInput(snapshot, CLASSIFIER_INPUT_TOKEN_CAP)
  const rules = classifyWithRules(rulesInput.text, hints)
  const fallback = (reason: ClassifierFallbackReason, code?: string): ClassificationOutcome => ({
    source: "rules_fallback",
    cached: false,
    labels: rules,
    input: rulesInput,
    classifierVersion: RULES_CLASSIFIER_VERSION,
    fallback: { reason, ...(code ? { code } : {}) },
  })

  if (snapshot.userText.trim().length === 0) return fallback("empty_request")
  if (!deps.call) return fallback(deps.unavailable ?? "model_unset")
  const request = buildClassifierPrompt(snapshot, CLASSIFIER_INPUT_TOKEN_CAP)
  if (request.overCap) return fallback("input_over_cap")
  // The user's own text, and the trusted context around it, never leave for a
  // routing label if the redaction gate objects to them.
  if (!hasNoLeakingPii(request.prompt)) return fallback("pii_blocked")

  const fromOutput = (output: ClassifierOutput, cached: boolean): ClassificationOutcome => ({
    source: "llm",
    cached,
    labels: labelsFromClassifierOutput(output, rules),
    input: request.input,
    classifierVersion: LLM_CLASSIFIER_VERSION,
  })

  const cacheKey = deps.cache
    ? deps.cache.keyOf(normalizeClassifierText(request.input.text), deps.configHash)
    : null
  if (cacheKey && deps.cache) {
    const hit = deps.cache.get(cacheKey, deps.now(), deps.cacheTtlMs)
    if (hit) return fromOutput(hit, true)
  }

  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const pending = deps.call(request.prompt, {
    system: request.system,
    maxTokens: CLASSIFIER_MAX_OUTPUT_TOKENS,
    temperature: 0,
    abortSignal: controller.signal,
  })
  // Whatever the call does after the timeout is the ledger's to book, not ours
  // to throw.
  pending.catch(() => undefined)
  let reply: string | typeof TIMED_OUT
  try {
    reply = await Promise.race([
      pending,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), deps.timeoutMs)
      }),
    ])
  } catch (error) {
    const { reason, code } = fallbackReasonOf(error)
    return fallback(reason, code)
  } finally {
    if (timer) clearTimeout(timer)
  }
  if (reply === TIMED_OUT) {
    // A bounded failure: the call is cut off, and the ledgered client books it
    // UNKNOWN with its reservation held when the abort lands (ROUTE-03).
    controller.abort()
    return fallback("timeout")
  }

  const parsed = parseClassifierReply(reply)
  // The call succeeded and was settled from its usage: an unusable reply is
  // still a paid one, and it stays booked.
  if (!parsed.ok) return fallback(parsed.reason)
  if (cacheKey && deps.cache) deps.cache.set(cacheKey, parsed.output, deps.now(), deps.cacheTtlMs)
  return fromOutput(parsed.output, false)
}

// ── the host binding ──────────────────────────────────────────────────────────

export interface RouteClassifierRequest {
  snapshot: RoutingSnapshot
  hints: RulesClassifierHints
  /** The surface that is routing: the classification call is booked, and re-checked, on it. */
  surface: RouterFusionSurface
  /** For the data class of the call (D30): a restricted project keeps its text off aggregators. */
  workspaceId: string | null
}

export type RouteClassifier = (request: RouteClassifierRequest) => Promise<ClassificationOutcome>

export interface RouteClassifierHostDeps {
  /** Reserve the call (test seam; the default is the ledgered utility path). */
  begin?: (input: BeginLedgeredUtilityCallInput) => Promise<UtilityGrant>
  /** The router model's raw client (test seam; the default uses the user's own key). */
  buildClient?: (providerId: string, modelId: string) => Promise<LlmClient | null>
  /** Which account's cache (test seam; the default is the account database's name). */
  accountKey?: () => Promise<string | null>
  now?: () => number
}

async function defaultAccountKey(): Promise<string | null> {
  const { getDb } = await import("@/lib/db/schema")
  return getDb().name
}

/**
 * The classifier this account's settings describe, or null while it is off.
 * Built per route host from the settings snapshot the route reads, so a
 * settings edit applies from the next route.
 */
export function createRouteClassifier(
  appSettings: AppSettings,
  deps: RouteClassifierHostDeps = {}
): RouteClassifier | null {
  const settings = normalizeRouterFusionSettings(appSettings.routerFusion).llmClassifier
  if (!settings.enabled) return null
  const providerId = settings.routerProviderId
  const modelId = settings.routerModelId
  const now = deps.now ?? (() => Date.now())

  const begin =
    deps.begin ??
    (async (input: BeginLedgeredUtilityCallInput): Promise<UtilityGrant> => {
      const { beginLedgeredUtilityCall } = await import("../calls/ledgered-llm-client")
      return beginLedgeredUtilityCall({ ...input, appSettings })
    })
  // Anything but a refusal that goes wrong before the call leaves is the
  // ledger's fault, and says so.
  const guardedBegin = async (input: BeginLedgeredUtilityCallInput): Promise<UtilityGrant> => {
    try {
      return await begin(input)
    } catch (error) {
      if (error instanceof RouterFusionRefusalError) throw error
      throw toInfrastructureFault(error) ?? error
    }
  }
  // Loaded on first use, so a route whose classifier is off (or answers from
  // the cache) never loads the provider SDK layer.
  const buildClient =
    deps.buildClient ??
    (async (provider: string, model: string): Promise<LlmClient | null> => {
      const [{ resolveDeploymentLlmConfig }, { createLlmClient }] = await Promise.all([
        import("@/lib/ai/renderer-llm-client"),
        import("@/lib/twin/distill/llm"),
      ])
      const config = resolveDeploymentLlmConfig(appSettings, provider, model, CLASSIFIER_FEATURE_ID)
      return config ? createLlmClient(config) : null
    })

  return async (request) => {
    let cache: ClassifierCache | null = null
    try {
      const account = await (deps.accountKey ?? defaultAccountKey)()
      if (account) cache = classifierCacheFor(account)
    } catch (error) {
      // No account database to key by: classify without a cache rather than
      // share one across accounts.
      console.warn("[router-fusion] classifier cache unavailable", error)
    }
    const common = {
      cache,
      timeoutMs: settings.timeoutMs,
      cacheTtlMs: settings.cacheTtlSeconds * 1_000,
      now,
    }
    if (!providerId || !modelId) {
      return classifyWithLlm(
        { ...common, call: null, unavailable: "model_unset", configHash: "" },
        request.snapshot,
        request.hints
      )
    }
    // The client is prepared inside the bounded call, and only on a cache miss.
    const call = async (prompt: string, options: ClassifierCallOptions): Promise<string> => {
      const inner = await buildClient(providerId, modelId)
      if (!inner) throw new ClassifierModelUnavailableError(providerId, modelId)
      const client = ledgeredLlmClient(
        inner,
        {
          surface: request.surface,
          // A utility run: session-less, its usage row written by the ledger,
          // never a cockpit row of its own.
          origin: "utility",
          featureId: CLASSIFIER_FEATURE_ID,
          providerId,
          modelId,
          workspaceId: request.workspaceId,
        },
        { begin: guardedBegin }
      )
      return client.complete(prompt, options)
    }
    return classifyWithLlm(
      { ...common, call, configHash: classifierConfigHash({ providerId, modelId }) },
      request.snapshot,
      request.hints
    )
  }
}

// ── the absorbed difficulty judge (D18) ──────────────────────────────────────

/**
 * The difficulty judge's question, answered by the classifier. The legacy Auto
 * ladder consults the judge only when its own score sits on a tier boundary;
 * with the classifier on, that consultation is one classification — the same
 * call, cache and PII gate as a routed turn — whose labels name a tier. Any
 * fallback answers `null`, which is the judge's own "the deterministic tier
 * stands": a failed classification never buys a second, unledgered opinion.
 */
export async function judgeDifficultyWithClassifier(
  appSettings: AppSettings,
  input: { promptText: string },
  deps: RouteClassifierHostDeps = {}
): Promise<{ tier: DifficultyTier } | null> {
  const classify = createRouteClassifier(appSettings, deps)
  if (!classify) return null
  const outcome = await classify({
    snapshot: intakeSnapshot(input.promptText),
    hints: { hasCode: /```/.test(input.promptText) },
    surface: "utilityLedger",
    workspaceId: null,
  })
  if (outcome.source !== "llm") return null
  const tier = difficultyTierOf(outcome.labels)
  return tier ? { tier } : null
}
