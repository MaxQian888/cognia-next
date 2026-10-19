/**
 * The configured Reader behind `web_fetch`.
 *
 * One logical read = one settings snapshot (`ReaderPolicy`), one runtime
 * scope, one cancellation signal, one deadline, one terminal outcome.
 *
 * Routing:
 * - **Direct-only requests** — `format: "raw"`, a non-GET method, a body, or
 *   caller-supplied target headers — only ever use the host's own HTTP path.
 *   Their URL, body, headers and cookies are never handed to a cloud reader,
 *   and a non-idempotent request is never replayed.
 * - **Private / loopback / link-local targets** — direct only, and only when
 *   the host allows private hosts. No third-party reader, ever.
 * - **Public bodyless GET** — `auto`: the origin platform scraper (WeChat,
 *   YouTube) or FxTwitter when enabled and applicable, then direct + local
 *   extraction, then — only after a fallback-eligible failure and only when
 *   external fallback is on — the enabled external readers in priority order.
 *   A pinned reader (`reader` argument) serves the request or fails with a
 *   structured reason; it never silently becomes another reader unless the
 *   caller passes `allowFallback: true`. A configured `defaultReader` is tried
 *   first and falls back per policy.
 *
 * Fallback-eligible failures: network rejection, too-little extracted text,
 * convertible binary (PDF), a public anti-bot answer, an attempt timeout, a
 * vendor failure. Terminal: 404/410, a login/paywall/auth challenge, an
 * ambiguous 403, a policy refusal, an oversized body, cancellation, and the
 * operation deadline.
 *
 * Budgets come from `@cognia/web-search/operation-policy`: 60 s per read,
 * 20 s per attempt, 3 attempts, 8 MiB decoded body, bounded admission per
 * scope. After cancellation nothing further runs: no fallback, no
 * distillation, no cache write, no late result.
 */

import type {
  CredentialedWebReaderId,
  WebReaderDistillation,
  WebReaderId,
} from "@cognia/agent-config-types"
import { CREDENTIALED_WEB_READER_IDS, REMOTE_WEB_READER_IDS } from "@cognia/agent-config-types"
import { parseHTML } from "@cognia/document/parsers/html-parser"
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import { isPrivateOrLocalHost } from "@cognia/network-guard"
import {
  createAttemptSignal,
  createOperationDeadline,
  EXTRACTED_RESULT_MAX_CHARS,
  getOperationAdmission,
  isAbortLike,
  OperationAdmissionError,
  RAW_RESULT_MAX_CHARS,
  READ_ATTEMPT_BUDGET_MS,
  RESPONSE_BYTE_CEILING,
  type OperationAdmission,
} from "@cognia/web-search/operation-policy"
import { readBodyBounded, ResponseTooLargeError } from "@cognia/web-search/bounded-response"
import type { PluginHostToolErrorCode } from "@/types/plugin/plugin-host-tools"
import {
  assertFetchTargetAllowed,
  evaluateFetchTarget,
  FetchTargetBlockedError,
} from "@/lib/web/fetch-guard"
import { fetchCacheKey, representationSize, type FetchCacheLike } from "@/lib/web/fetch-cache"
import { platformReaderFor, scrapePlatform } from "./dispatch"
import { readViaJina } from "./jina"
import { readWithVendor } from "./vendor-readers"
import {
  boundedDetail,
  isFallbackEligible,
  type ReadContent,
  type ReadFailure,
  type ReadFailureClass,
  type StageOutcome,
  type StatusSource,
} from "./read-outcome"
import type { ReaderPolicy } from "./reader-settings"

/** How `web_fetch` should present the response body. */
export type FetchFormat = "auto" | "text" | "raw"

export interface ReadRequest {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
  /** Read-window cap, in CHARACTERS (legacy name). */
  maxBytes?: number
  format?: FetchFormat
  prompt?: string
  /** Read-window start, in characters. */
  offset?: number
  /** Pin one reader. Strict unless `allowFallback: true`. */
  reader?: WebReaderId
  /** `false` turns a configured default reader into a strict pin; `true` lets a pinned reader fall back. */
  allowFallback?: boolean
}

/** Distill page text down to just the content relevant to `prompt`. */
export type FetchSummarize = (text: string, prompt: string, signal?: AbortSignal) => Promise<string>

export interface ReaderHostDeps {
  policy: ReaderPolicy
  /** The host's own transport for direct reads, platform scrapers, FxTwitter and Jina. */
  fetchImpl?: typeof fetch
  userAgent?: string
  summarize?: FetchSummarize
  signal?: AbortSignal
  cache?: FetchCacheLike
  /** Runtime/account scope (opaque); isolates cache and admission. */
  scope?: string
  /**
   * The current authority. Compared with `scope` before every outbound stage,
   * before a cache hit is served and before publishing; a mismatch (account
   * switch, or the host revoking the settings this read was planned under)
   * stops the read.
   */
  activeScope?: () => string | undefined
  allowPrivateHosts?: boolean
  /** The stored vendor credential for a vendor reader, or undefined. */
  credentialFor?: (reader: CredentialedWebReaderId) => string | undefined
  /**
   * Readers this host can physically reach (e.g. Jina needs a CORS-free
   * transport). Absent ⇒ every reader is reachable.
   */
  hostReachable?: Partial<Record<WebReaderId, boolean>>
  /** Whether the transport cancels the physical request on abort (disclosed when false). */
  transportCancels?: boolean
  admission?: OperationAdmission
  /** Test seams. */
  attemptBudgetMs?: number
  byteCeiling?: number
}

export type ReaderFailureReason =
  | "invalid-url"
  | "credentialed-url"
  | "conflicting-mode"
  | "reader-not-allowed"
  | "reader-unavailable"
  | "blocked-target"
  | "private-target"
  | "sensitive-data"
  | "too-large"
  | "cancelled"
  | "timeout"
  | "scope-changed"
  | "admission-full"
  | "distillation-unavailable"
  | "distillation-failed"
  | "unsupported-content"
  | "not-found"
  | "auth-required"
  | "all-readers-failed"

export interface ReaderFailureResult {
  ok: false
  code: PluginHostToolErrorCode
  error: string
  reason: ReaderFailureReason
}

const GENERIC_DISTILL_PROMPT =
  "Summarize the key facts, figures, names, dates, quotes, and conclusions on this page."

/** Below this many characters, local extraction is "thin" (a JS-rendered page). */
const MIN_LOCAL_EXTRACT = 200

const ANTI_BOT_MARKERS =
  /(just a moment|cf-chl|cf_chl|attention required|captcha|ddos-guard|datadome|perimeterx|_incapsula_|access denied by|checking your browser)/i
const LOGIN_MARKERS =
  /(sign[ -]?in to continue|log[ -]?in to continue|please (?:sign|log)[ -]?in|subscribe to (?:continue|read)|paywall|members only|登录后(?:查看|继续|阅读)|请先登录)/i

function fail(
  code: PluginHostToolErrorCode,
  reason: ReaderFailureReason,
  error: string
): ReaderFailureResult {
  return { ok: false, code, reason, error }
}

function isTextualContentType(contentType: string): boolean {
  if (!contentType.trim()) return true
  const c = contentType.toLowerCase()
  if (c.startsWith("text/")) return true
  return /(json|xml|xhtml|javascript|ecmascript|csv|yaml|html|markdown|graphql|x-www-form-urlencoded|plain)/.test(
    c
  )
}

function looksLikePdf(contentType: string, url: string): boolean {
  return /application\/pdf/i.test(contentType) || /\.pdf(?:$|[?#])/i.test(url)
}

/**
 * Slice a `[offset, offset+cap)` window out of `text`. Offsets and caps are
 * character counts (the legacy `maxBytes` name notwithstanding).
 */
export function windowText(
  text: string,
  offset: number | undefined,
  cap: number
): { slice: string; total: number; start: number; truncated: boolean; nextOffset?: number } {
  const total = text.length
  const start = offset && offset > 0 ? Math.min(Math.floor(offset), total) : 0
  const slice = text.slice(start, start + cap)
  const end = start + slice.length
  const truncated = end < total
  return { slice, total, start, truncated, ...(truncated ? { nextOffset: end } : {}) }
}

/** Redirect hops a direct read follows, each re-checked against the target guard. */
const MAX_DIRECT_REDIRECTS = 5

function classifyOriginStatus(status: number, body: string): ReadFailureClass | undefined {
  if (status === 404 || status === 410) return "not-found"
  if (status === 401 || status === 407) return "auth-required"
  if (status === 403 || status === 429 || status === 503) {
    if (ANTI_BOT_MARKERS.test(body)) return "anti-bot"
    if (status === 403 && LOGIN_MARKERS.test(body)) return "auth-required"
    if (status === 429) return "anti-bot"
    return status === 403 ? "ambiguous-forbidden" : undefined
  }
  return undefined
}

interface ResolvedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
  format: FetchFormat
  directOnly: boolean
  privateTarget: boolean
}

/** Is `reader` usable on this host for this policy (ignoring the URL)? */
function readerUsable(reader: WebReaderId, deps: ReaderHostDeps): boolean {
  if (!deps.policy.enabled.has(reader)) return false
  if (deps.hostReachable && deps.hostReachable[reader] === false) return false
  if ((CREDENTIALED_WEB_READER_IDS as readonly string[]).includes(reader)) {
    return Boolean(deps.credentialFor?.(reader as CredentialedWebReaderId)?.trim())
  }
  return true
}

/**
 * Build the ordered reader plan for a public bodyless GET. Pure, so the
 * routing decision is testable on its own.
 */
export function planReaders(
  url: string,
  request: Pick<ReadRequest, "reader" | "allowFallback">,
  deps: Pick<ReaderHostDeps, "policy" | "hostReachable" | "credentialFor">
): { plan: WebReaderId[]; strict: boolean; pinned?: WebReaderId } {
  const policy = deps.policy
  const usable = (id: WebReaderId) => readerUsable(id, deps as ReaderHostDeps)
  const platform = platformReaderFor(url)
  const auto: WebReaderId[] = []
  if (platform && usable(platform)) auto.push(platform)
  if (usable("direct")) auto.push("direct")
  if (policy.externalFallback) {
    for (const id of policy.externalOrder) if (usable(id)) auto.push(id)
  }

  if (request.reader) {
    const strict = request.allowFallback !== true
    const rest = auto.filter((id) => id !== request.reader)
    return { plan: [request.reader, ...(strict ? [] : rest)], strict, pinned: request.reader }
  }
  if (policy.defaultReader !== "auto") {
    const pinned = policy.defaultReader
    const strict = request.allowFallback === false
    const rest = auto.filter((id) => id !== pinned)
    return { plan: [pinned, ...(strict ? [] : rest)], strict, pinned }
  }
  return { plan: auto, strict: false }
}

/** The effective distillation question for this read, if any. */
function distillQuestion(
  prompt: string | undefined,
  mode: WebReaderDistillation
): string | undefined {
  if (prompt?.trim()) return prompt
  return mode === "off" ? undefined : GENERIC_DISTILL_PROMPT
}

/**
 * The normalized representation a successful read produced, after
 * distillation and before windowing. This is what the cache stores.
 */
interface ReadRepresentation {
  ok: boolean
  status: number
  statusSource: StatusSource
  originStatus?: number
  url: string
  contentType: string
  reader: WebReaderId
  source?: string
  title?: string
  /** Extracted / distilled text (mutually exclusive with `body`). */
  text?: string
  /** Raw body for non-extracted responses. */
  body?: string
  binary?: true
  note?: string
  extraction?: string
  distilled?: boolean
  warnings?: string[]
}

function shapeWindow(
  rep: ReadRepresentation,
  request: ReadRequest,
  extras: { cacheHit?: boolean; cacheBypass?: string; attempts?: WebReaderId[] }
): Record<string, unknown> {
  const isText = typeof rep.text === "string"
  const userCap = request.maxBytes && request.maxBytes > 0 ? request.maxBytes : undefined
  const cap = userCap ?? (isText ? EXTRACTED_RESULT_MAX_CHARS : RAW_RESULT_MAX_CHARS)
  const content = isText ? rep.text! : rep.body
  const win = content !== undefined ? windowText(content, request.offset, cap) : undefined
  const warnings = [...(rep.warnings ?? []), ...(extras.cacheBypass ? [extras.cacheBypass] : [])]
  return {
    ok: rep.ok,
    status: rep.status,
    url: rep.url,
    contentType: rep.contentType,
    ...(rep.source ? { source: rep.source } : {}),
    reader: rep.reader,
    statusSource: rep.statusSource,
    ...(rep.originStatus !== undefined ? { originStatus: rep.originStatus } : {}),
    ...(rep.title ? { title: rep.title } : {}),
    ...(win
      ? {
          [isText ? "text" : "body"]: win.slice,
          truncated: win.truncated,
          ...(win.total > cap || win.start > 0 ? { totalLength: win.total } : {}),
          ...(win.nextOffset != null ? { nextOffset: win.nextOffset } : {}),
          readWindow: { offset: win.start, cap, unit: "characters" as const },
        }
      : {}),
    ...(rep.binary ? { binary: true as const, note: rep.note } : {}),
    ...(rep.extraction ? { extraction: rep.extraction } : {}),
    ...(rep.distilled !== undefined ? { distilled: rep.distilled } : {}),
    ...(warnings.length ? { warnings } : {}),
    ...(extras.cacheHit ? { cacheHit: true } : {}),
    ...(extras.attempts && extras.attempts.length > 1 ? { attemptedReaders: extras.attempts } : {}),
  }
}

function resolveRequest(request: ReadRequest): ResolvedRequest | ReaderFailureResult {
  if (!request.url || typeof request.url !== "string") {
    return fail("invalid-arguments", "invalid-url", "url is required")
  }
  let parsed: URL | null = null
  try {
    parsed = new URL(request.url)
  } catch {
    parsed = null
  }
  if (parsed && (parsed.username || parsed.password)) {
    return fail(
      "invalid-arguments",
      "credentialed-url",
      "URLs with embedded credentials are not fetched; remove the user:password part"
    )
  }
  const method = (request.method ?? "GET").toUpperCase()
  const headers: Record<string, string> = { ...(request.headers ?? {}) }
  const format: FetchFormat = request.format ?? "auto"
  const callerHeaders = Object.keys(headers).length > 0
  const directOnly =
    format === "raw" ||
    method !== "GET" ||
    (request.body !== undefined && request.body !== "") ||
    callerHeaders
  const privateTarget = parsed ? isPrivateOrLocalHost(parsed.hostname) : false
  return {
    url: request.url,
    method,
    headers,
    ...(request.body !== undefined ? { body: request.body } : {}),
    format,
    directOnly,
    privateTarget,
  }
}

/**
 * Perform one configured read. Returns the legacy `web_fetch` success shape
 * (plus additive metadata) or a structured {@link ReaderFailureResult}.
 */
export async function readWithPolicy(
  request: ReadRequest,
  deps: ReaderHostDeps
): Promise<Record<string, unknown> | ReaderFailureResult> {
  const resolved = resolveRequest(request)
  if ("ok" in resolved) return resolved
  const policy = deps.policy

  // Gate the FINAL outbound headers, including the host-injected User-Agent.
  const outboundHeaders =
    deps.userAgent && !resolved.headers["User-Agent"]
      ? { ...resolved.headers, "User-Agent": deps.userAgent }
      : resolved.headers
  if (!hasNoLeakingPiiDeep({ url: resolved.url, headers: outboundHeaders, body: resolved.body })) {
    return fail(
      "blocked",
      "sensitive-data",
      "web_fetch blocked: outbound request contains sensitive data"
    )
  }

  if (resolved.directOnly) {
    if (policy.distillation === "required") {
      return fail(
        "invalid-arguments",
        "conflicting-mode",
        "Required distillation is on, so raw, non-GET, header or body requests are unavailable. Change the Reader distillation setting to use raw HTTP."
      )
    }
    if (request.reader && request.reader !== "direct") {
      return fail(
        "invalid-arguments",
        "reader-not-allowed",
        `Reader "${request.reader}" cannot serve raw, non-GET, header or body requests; only the direct reader can`
      )
    }
  }

  try {
    assertFetchTargetAllowed(resolved.url, { allowPrivateHosts: deps.allowPrivateHosts })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return fail(
      "blocked",
      err instanceof FetchTargetBlockedError ? "blocked-target" : "invalid-url",
      message
    )
  }

  if (resolved.privateTarget && request.reader && request.reader !== "direct") {
    return fail(
      "blocked",
      "private-target",
      "Private and local addresses are only read directly; no external reader may receive them"
    )
  }

  const admission = deps.admission ?? getOperationAdmission()
  const scope = deps.scope ?? "default"
  // The whole-read deadline starts before admission: time spent queued for a
  // slot counts against the same budget.
  const deadline = createOperationDeadline(policy.timeoutMs, deps.signal)
  let release: (() => void) | undefined
  try {
    release = await admission.acquire(scope, "read", deadline.signal)
  } catch (error) {
    deadline.dispose()
    if (error instanceof OperationAdmissionError) {
      return fail("rate-limited", "admission-full", error.message)
    }
    return deadline.timedOut() && !deps.signal?.aborted
      ? fail(
          "execution-failed",
          "timeout",
          `web_fetch exceeded its ${Math.round(policy.timeoutMs / 1000)}s budget waiting for a slot`
        )
      : fail("execution-failed", "cancelled", "web_fetch was cancelled")
  }

  try {
    return await runRead(request, resolved, deps, deadline.signal, () => deadline.timedOut())
  } finally {
    deadline.dispose()
    release()
  }
}

async function runRead(
  request: ReadRequest,
  resolved: ResolvedRequest,
  deps: ReaderHostDeps,
  signal: AbortSignal,
  timedOut: () => boolean
): Promise<Record<string, unknown> | ReaderFailureResult> {
  const policy = deps.policy
  const cancelledResult = (): ReaderFailureResult =>
    timedOut() && !deps.signal?.aborted
      ? fail(
          "execution-failed",
          "timeout",
          `web_fetch exceeded its ${Math.round(policy.timeoutMs / 1000)}s budget`
        )
      : fail("execution-failed", "cancelled", "web_fetch was cancelled")

  // Plan. Direct-only and private requests never consult remote readers.
  let plan: WebReaderId[]
  let strict = false
  let pinned: WebReaderId | undefined
  if (resolved.directOnly || resolved.privateTarget) {
    if (!readerUsable("direct", deps)) {
      return fail(
        "unsupported-host",
        "reader-unavailable",
        "This request can only be read directly, and the direct reader is disabled in Settings → Search & Reading."
      )
    }
    plan = ["direct"]
    strict = true
  } else {
    const planned = planReaders(resolved.url, request, deps)
    plan = planned.plan
    strict = planned.strict
    pinned = planned.pinned
  }
  if (pinned && !readerUsable(pinned, deps) && strict) {
    return fail(
      "unsupported-host",
      "reader-unavailable",
      `Reader "${pinned}" is not enabled, has no stored credential, or is unreachable on this host`
    )
  }
  plan = plan.filter((id, index) => (index === 0 && pinned === id ? readerUsable(id, deps) : true))
  if (plan.length === 0) {
    return fail(
      "unsupported-host",
      "reader-unavailable",
      "No reader is enabled for this request. Enable the direct reader or another reader in Settings → Search & Reading."
    )
  }

  // Cache: authority was re-evaluated above; identity carries scope + policy.
  const question = distillQuestion(request.prompt, policy.distillation)
  const cacheable = Boolean(deps.cache) && !resolved.directOnly && !resolved.privateTarget
  const cacheKey = cacheable
    ? fetchCacheKey({
        scope: deps.scope,
        url: resolved.url,
        readerRevision: `${policy.revision}|${request.reader ?? ""}|${String(request.allowFallback ?? "")}`,
        format: resolved.format,
        prompt: request.prompt,
        distillation: policy.distillation,
      })
    : ""
  const scopeChanged = () => Boolean(deps.activeScope && deps.activeScope() !== deps.scope)
  const scopeChangedResult = () =>
    fail(
      "execution-failed",
      "scope-changed",
      "Read discarded: the account, runtime or Reader settings changed during the request"
    )
  if (cacheable) {
    const hit = deps.cache!.get(cacheKey) as ReadRepresentation | null
    // A hit is published under the same authority as a fresh read: not after
    // cancellation, not across a scope change, and only while the reader that
    // produced it is still enabled, credentialed and reachable here.
    if (hit && readerUsable(hit.reader, deps)) {
      if (signal.aborted) return cancelledResult()
      if (scopeChanged()) return scopeChangedResult()
      return shapeWindow(hit, request, { cacheHit: true })
    }
  }

  const maxAttempts = Math.max(1, policy.maxAttempts)
  const attempted: WebReaderId[] = []
  let originFailure: { status?: number; failure: ReadFailureClass; http?: StageOutcome } | undefined
  let lastFailure: ReadFailure | undefined
  let produced: ReadContent | undefined
  let terminal: StageOutcome | undefined

  for (const reader of plan) {
    if (attempted.length >= maxAttempts) break
    if (signal.aborted) return cancelledResult()
    // External readers run only as the pinned reader or after an eligible failure.
    const isRemote = REMOTE_WEB_READER_IDS.includes(reader) && reader !== "fxtwitter"
    if (
      isRemote &&
      reader !== pinned &&
      attempted.length > 0 &&
      lastFailure &&
      !isFallbackEligible(lastFailure.failure)
    ) {
      break
    }
    if (!readerUsable(reader, deps)) continue
    // Nothing leaves the host under an authority that has since changed.
    if (scopeChanged()) return scopeChangedResult()
    attempted.push(reader)

    let outcome: StageOutcome
    try {
      outcome = await runStage(reader, resolved, deps, signal)
    } catch (error) {
      if (signal.aborted || isAbortLike(error)) return cancelledResult()
      outcome = {
        kind: "failure",
        reader,
        failure: "network",
        detail: boundedDetail(error),
      }
    }

    if (outcome.kind === "content") {
      if (
        reader === "direct" &&
        outcome.text.length < MIN_LOCAL_EXTRACT &&
        plan.indexOf(reader) < plan.length - 1 &&
        !strict
      ) {
        // Thin local extraction: keep it as the fallback answer, try the next reader.
        produced = outcome
        lastFailure = {
          kind: "failure",
          reader,
          failure: "thin",
          detail: "too little readable text",
        }
        continue
      }
      if (produced && produced.text.length >= outcome.text.length) break
      produced = outcome
      break
    }
    if (outcome.kind === "failure") {
      lastFailure = outcome
      if (outcome.failure === "too-large") {
        terminal = outcome
        break
      }
      if (reader === "direct" || reader === "platform") {
        originFailure = { status: outcome.status, failure: outcome.failure }
      }
      if (strict || !isFallbackEligible(outcome.failure)) {
        terminal = outcome
        break
      }
      continue
    }
    // `http` / `binary` from direct.
    const failure = outcome.kind === "http" ? outcome.failure : "binary"
    if (outcome.kind === "binary" && !outcome.isPdf) {
      terminal = outcome
      break
    }
    if (!failure || strict || !isFallbackEligible(failure)) {
      terminal = outcome
      break
    }
    originFailure = { status: outcome.status, failure, http: outcome }
    lastFailure = {
      kind: "failure",
      reader,
      failure,
      detail: "direct read not usable",
      status: outcome.status,
    }
  }

  if (signal.aborted) return cancelledResult()

  // Whenever this read distills (a `prompt`, best-effort or required), a
  // readable non-HTML body (plain text, JSON, XML, …) becomes text and goes
  // through the extractor. Required distillation never returns raw text; raw
  // requests are direct-only and never reach here with a question.
  if (
    !produced &&
    question !== undefined &&
    resolved.format !== "raw" &&
    terminal?.kind === "http" &&
    terminal.ok &&
    terminal.body.trim()
  ) {
    produced = {
      kind: "content",
      reader: "direct",
      text: terminal.body,
      contentType: terminal.contentType,
      status: terminal.status,
      statusSource: "origin",
      extraction: /json/i.test(terminal.contentType) ? "json" : "text",
    }
    terminal = undefined
  }

  let rep: ReadRepresentation | ReaderFailureResult
  if (produced) {
    rep = await finishContent(produced, resolved, deps, signal, question, originFailure?.status)
  } else if (terminal || originFailure?.http) {
    rep = finishTerminal((terminal ?? originFailure!.http)!, resolved, policy.distillation)
  } else {
    rep = failureToResult(lastFailure, plan)
  }
  if (signal.aborted) return cancelledResult()
  if ("code" in rep) return rep

  // Final authority check before publishing or caching.
  if (scopeChanged()) return scopeChangedResult()
  let cacheBypass: string | undefined
  if (cacheable && rep.ok && !rep.binary) {
    const stored = deps.cache!.set(cacheKey, rep, representationSize(rep))
    if (stored === false)
      cacheBypass = "cache-bypass: document too large to keep; paging refetches it"
  }
  if (deps.transportCancels === false) {
    rep.warnings = [
      ...(rep.warnings ?? []),
      "transport-cancellation: this host cannot recall an in-flight request",
    ]
  }
  return shapeWindow(rep, request, { cacheBypass, attempts: attempted })
}

async function runStage(
  reader: WebReaderId,
  resolved: ResolvedRequest,
  deps: ReaderHostDeps,
  signal: AbortSignal
): Promise<StageOutcome> {
  const attemptBudget = deps.attemptBudgetMs ?? READ_ATTEMPT_BUDGET_MS
  const attempt = createAttemptSignal(signal, attemptBudget)
  const fetchImpl = deps.fetchImpl ?? fetch
  try {
    switch (reader) {
      case "direct":
        return await readDirect(resolved, deps, fetchImpl, attempt.signal)
      case "platform":
      case "fxtwitter": {
        // Each origin reader serves only its own sites: `platform` must never
        // reach FxTwitter for an X link (a third party the user may have
        // disabled), and neither applies to an ordinary page.
        if (platformReaderFor(resolved.url) !== reader) {
          return {
            kind: "failure",
            reader,
            failure: "unavailable",
            detail: `the ${reader} reader does not handle this site`,
          }
        }
        const scraped = await scrapePlatform(resolved.url, fetchImpl, attempt.signal)
        if (!scraped || !scraped.markdown.trim()) {
          return {
            kind: "failure",
            reader,
            failure: "thin",
            detail: "platform reader returned nothing",
          }
        }
        return {
          kind: "content",
          reader,
          source: scraped.source,
          text: scraped.markdown,
          ...(scraped.title ? { title: scraped.title } : {}),
          contentType: "text/markdown",
          status: 200,
          statusSource: reader === "platform" ? "origin" : "reader-service",
          extraction: "markdown",
        }
      }
      case "jina": {
        const outcome = await readViaJina(
          resolved.url,
          fetchImpl,
          attempt.signal,
          deps.byteCeiling ?? RESPONSE_BYTE_CEILING
        )
        if (!outcome.ok) {
          return {
            kind: "failure",
            reader,
            failure:
              outcome.error === "too_large"
                ? "too-large"
                : outcome.status === 429
                  ? "vendor-rate-limit"
                  : outcome.error === "empty_content"
                    ? "thin"
                    : "vendor-error",
            detail: boundedDetail(outcome.error),
            ...(outcome.status !== undefined
              ? { status: outcome.status, statusSource: "reader-service" as const }
              : {}),
          }
        }
        return {
          kind: "content",
          reader,
          source: "jina",
          text: outcome.result.markdown,
          ...(outcome.result.title ? { title: outcome.result.title } : {}),
          contentType: "text/markdown",
          status: outcome.status,
          statusSource: "reader-service",
          extraction: "markdown",
        }
      }
      default: {
        const key = deps.credentialFor?.(reader as CredentialedWebReaderId)
        if (!key) {
          return { kind: "failure", reader, failure: "unavailable", detail: "no stored credential" }
        }
        return await readWithVendor(reader as CredentialedWebReaderId, resolved.url, key, {
          signal: attempt.signal,
          attemptBudgetMs: attemptBudget,
        })
      }
    }
  } catch (error) {
    // The attempt's own deadline (not the operation's) ⇒ eligible to fall back.
    if (attempt.signal.aborted && !signal.aborted) {
      return {
        kind: "failure",
        reader,
        failure: "attempt-timeout",
        detail: "reader attempt timed out",
      }
    }
    throw error
  } finally {
    attempt.dispose()
  }
}

function isStageOutcome(value: Response | StageOutcome): value is StageOutcome {
  return typeof (value as { kind?: unknown }).kind === "string"
}

function blockedRedirect(detail: string): StageOutcome {
  return { kind: "failure", reader: "direct", failure: "blocked", detail: boundedDetail(detail) }
}

/** Is `url` a target this read may reach (same guard as the first hop)? */
function redirectAllowed(url: string, deps: ReaderHostDeps): boolean {
  return evaluateFetchTarget(url, { allowPrivateHosts: deps.allowPrivateHosts === true }).allowed
}

/**
 * Issue the direct request, following redirects one hop at a time so every
 * hop passes the same target guard as the first (a public URL must not
 * bounce the request onto a private or metadata address). Transports that
 * cannot expose a redirect (a browser's opaque redirect) are retried with
 * automatic following, and their final URL is checked before the body is
 * used; a transport that follows on its own is checked the same way.
 */
async function fetchDirectGuarded(
  resolved: ResolvedRequest,
  headers: Record<string, string>,
  deps: ReaderHostDeps,
  fetchImpl: typeof fetch,
  signal: AbortSignal
): Promise<Response | StageOutcome> {
  let url = resolved.url
  let method = resolved.method
  let body = resolved.body
  let hopHeaders = headers
  for (let hop = 0; ; hop++) {
    const res = await fetchImpl(url, {
      method,
      headers: hopHeaders,
      ...(body !== undefined ? { body } : {}),
      signal,
      redirect: "manual",
    })
    if (res.type === "opaqueredirect") {
      const followed = await fetchImpl(url, {
        method,
        headers: hopHeaders,
        ...(body !== undefined ? { body } : {}),
        signal,
        redirect: "follow",
      })
      if (followed.url && !redirectAllowed(followed.url, deps)) {
        await followed.body?.cancel().catch(() => {})
        return blockedRedirect(`redirected to a blocked target: ${followed.url}`)
      }
      return followed
    }
    const location = res.status >= 300 && res.status < 400 ? res.headers?.get?.("location") : null
    if (!location) {
      if (res.url && res.url !== url && !redirectAllowed(res.url, deps)) {
        await res.body?.cancel().catch(() => {})
        return blockedRedirect(`redirected to a blocked target: ${res.url}`)
      }
      return res
    }
    await res.body?.cancel().catch(() => {})
    if (hop >= MAX_DIRECT_REDIRECTS) return blockedRedirect("too many redirects")
    let next: URL
    try {
      next = new URL(location, url)
    } catch {
      return blockedRedirect("redirect to an invalid URL")
    }
    if (!redirectAllowed(next.toString(), deps)) {
      return blockedRedirect(`redirected to a blocked target: ${next.toString()}`)
    }
    // Credentials the caller addressed to one origin never follow to another.
    if (next.origin !== new URL(url).origin) {
      hopHeaders = Object.fromEntries(
        Object.entries(hopHeaders).filter(
          ([name]) => !/^(authorization|cookie|proxy-authorization)$/i.test(name)
        )
      )
    }
    // 303, and 301/302 after a non-GET, continue as a bodyless GET.
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== "GET")) {
      method = "GET"
      body = undefined
    }
    url = next.toString()
  }
}

async function readDirect(
  resolved: ResolvedRequest,
  deps: ReaderHostDeps,
  fetchImpl: typeof fetch,
  signal: AbortSignal
): Promise<StageOutcome> {
  const headers = { ...resolved.headers }
  if (deps.userAgent && !headers["User-Agent"]) headers["User-Agent"] = deps.userAgent
  let res: Response
  try {
    const fetched = await fetchDirectGuarded(resolved, headers, deps, fetchImpl, signal)
    if (isStageOutcome(fetched)) return fetched
    res = fetched
  } catch (error) {
    if (signal.aborted || isAbortLike(error)) throw error
    if (error instanceof FetchTargetBlockedError) {
      return { kind: "failure", reader: "direct", failure: "blocked", detail: boundedDetail(error) }
    }
    return { kind: "failure", reader: "direct", failure: "network", detail: boundedDetail(error) }
  }
  const contentType = res.headers?.get?.("content-type") ?? ""
  const mayExtract = resolved.format !== "raw"

  if (mayExtract && !isTextualContentType(contentType)) {
    await res.body?.cancel().catch(() => {})
    // Origin status first: an auth wall or a missing file served as a PDF is
    // terminal, never a document to hand to a converting reader.
    if (!res.ok) {
      const failure = classifyOriginStatus(res.status, "")
      return {
        kind: "http",
        reader: "direct",
        ok: false,
        status: res.status,
        contentType,
        body: "",
        ...(failure ? { failure } : {}),
      }
    }
    return {
      kind: "binary",
      reader: "direct",
      ok: res.ok,
      status: res.status,
      contentType,
      isPdf: looksLikePdf(contentType, resolved.url),
    }
  }

  let raw: string
  try {
    raw = await readBodyBounded(res, deps.byteCeiling ?? RESPONSE_BYTE_CEILING)
  } catch (error) {
    if (error instanceof ResponseTooLargeError) {
      return {
        kind: "failure",
        reader: "direct",
        failure: "too-large",
        detail: error.message,
        status: res.status,
        statusSource: "origin",
      }
    }
    throw error
  }

  if (!res.ok) {
    return {
      kind: "http",
      reader: "direct",
      ok: false,
      status: res.status,
      contentType,
      body: raw,
      ...(classifyOriginStatus(res.status, raw)
        ? { failure: classifyOriginStatus(res.status, raw) }
        : {}),
    }
  }

  const wantsExtract = mayExtract && (resolved.format === "text" || /html/i.test(contentType))
  if (wantsExtract && raw) {
    try {
      const parsed = await parseHTML(raw, { includeLinks: false, includeImages: false })
      const text = parsed.text?.trim() ?? ""
      // A short page that is only a sign-in / subscription wall is an auth
      // failure even with a 200: it is terminal, and its URL is never handed
      // to an external reader as merely "thin".
      if (text.length < MIN_LOCAL_EXTRACT && LOGIN_MARKERS.test(text || raw)) {
        return {
          kind: "failure",
          reader: "direct",
          failure: "auth-required",
          detail: "the page asks to sign in or subscribe",
          status: res.status,
          statusSource: "origin",
        }
      }
      if (text) {
        return {
          kind: "content",
          reader: "direct",
          text,
          ...(parsed.title ? { title: parsed.title } : {}),
          contentType,
          status: res.status,
          statusSource: "origin",
          extraction: "html",
        }
      }
    } catch {
      // Malformed HTML — fall through to the raw body below.
    }
    if (/html/i.test(contentType) && mayExtract) {
      return {
        kind: "http",
        reader: "direct",
        ok: true,
        status: res.status,
        contentType,
        body: raw,
        failure: "thin",
      }
    }
  }
  return { kind: "http", reader: "direct", ok: true, status: res.status, contentType, body: raw }
}

/** Shape a content outcome: distillation per policy, status semantics. */
async function finishContent(
  content: ReadContent,
  resolved: ResolvedRequest,
  deps: ReaderHostDeps,
  signal: AbortSignal,
  question: string | undefined,
  originStatus: number | undefined
): Promise<ReadRepresentation | ReaderFailureResult> {
  const mode = deps.policy.distillation
  const base: ReadRepresentation = {
    ok: true,
    status: content.status,
    statusSource: content.statusSource,
    // Only a known origin status is reported, never an invented 200.
    ...(content.statusSource === "reader-service" && originStatus !== undefined
      ? { originStatus }
      : {}),
    url: resolved.url,
    contentType: content.contentType,
    reader: content.reader,
    ...(content.source ? { source: content.source } : {}),
    ...(content.title ? { title: content.title } : {}),
    extraction: content.extraction,
  }
  const text = content.text.trim()
  if (!question) return { ...base, text, ...(mode === "off" ? {} : { distilled: false }) }
  return distill(base, text, question, mode, deps, signal)
}

async function distill(
  base: ReadRepresentation,
  text: string,
  question: string,
  mode: WebReaderDistillation,
  deps: ReaderHostDeps,
  signal: AbortSignal
): Promise<ReadRepresentation | ReaderFailureResult> {
  const required = mode === "required"
  if (!text) return { ...base, text, distilled: false }
  if (!deps.summarize) {
    if (required) {
      return fail(
        "unsupported-host",
        "distillation-unavailable",
        "Required distillation is on but no utility model is available on this host; configure one or change the Reader distillation setting."
      )
    }
    return {
      ...base,
      text,
      distilled: false,
      warnings: ["distillation-unavailable: no utility model on this host"],
    }
  }
  try {
    const focused = (await deps.summarize(text, question, signal))?.trim()
    if (signal.aborted) {
      return fail("execution-failed", "cancelled", "web_fetch was cancelled")
    }
    if (focused)
      return {
        ...base,
        text: focused,
        distilled: true,
        extraction: `${base.extraction ?? "text"}+distilled`,
      }
    if (required)
      return fail(
        "execution-failed",
        "distillation-failed",
        "The utility model returned no extraction"
      )
    return { ...base, text, distilled: false, warnings: ["distillation-failed: empty extraction"] }
  } catch (error) {
    if (signal.aborted) return fail("execution-failed", "cancelled", "web_fetch was cancelled")
    if (required) {
      return fail(
        "execution-failed",
        "distillation-failed",
        `Distillation failed: ${boundedDetail(error)}`
      )
    }
    return {
      ...base,
      text,
      distilled: false,
      warnings: [`distillation-failed: ${boundedDetail(error)}`],
    }
  }
}

/** A direct HTTP / binary outcome, or a terminal failure. */
function finishTerminal(
  outcome: StageOutcome,
  resolved: ResolvedRequest,
  mode: WebReaderDistillation
): ReadRepresentation | ReaderFailureResult {
  if (outcome.kind === "failure") {
    return failureToResult(outcome, [outcome.reader])
  }
  if (outcome.kind === "binary") {
    if (mode === "required") {
      return fail(
        "execution-failed",
        "unsupported-content",
        "Required distillation cannot read this binary content type"
      )
    }
    return {
      ok: outcome.ok,
      status: outcome.status,
      statusSource: "origin",
      url: resolved.url,
      contentType: outcome.contentType,
      reader: "direct",
      binary: true,
      note: outcome.isPdf
        ? "PDF content was not extracted to text. Enable an external reader (Jina or a vendor reader) in Settings → Search & Reading, or fetch with format:'raw'."
        : "Non-text (binary) content was not extracted. Use format:'raw' to get the raw bytes as a string.",
    }
  }
  if (outcome.kind === "content") {
    return {
      ok: true,
      status: outcome.status,
      statusSource: outcome.statusSource,
      url: resolved.url,
      contentType: outcome.contentType,
      reader: outcome.reader,
      text: outcome.text,
    }
  }
  // Direct HTTP outcome surfaced verbatim — except that required distillation
  // never hands back an undistilled body.
  if (mode === "required") {
    return {
      ok: outcome.ok,
      status: outcome.status,
      statusSource: "origin",
      url: resolved.url,
      contentType: outcome.contentType,
      reader: "direct",
      distilled: false,
      warnings: ["body-withheld: required distillation does not return raw response bodies"],
    }
  }
  return {
    ok: outcome.ok,
    status: outcome.status,
    statusSource: "origin",
    url: resolved.url,
    contentType: outcome.contentType,
    reader: "direct",
    body: outcome.body,
    ...(outcome.failure ? { warnings: [`origin-${outcome.failure}`] } : {}),
  }
}

function failureToResult(
  failure: ReadFailure | undefined,
  plan: WebReaderId[]
): ReaderFailureResult {
  if (!failure) {
    return fail(
      "execution-failed",
      "all-readers-failed",
      `No reader produced content (tried: ${plan.join(", ")})`
    )
  }
  const tail = `${failure.reader}: ${failure.detail}`
  switch (failure.failure) {
    case "too-large":
      return fail(
        "execution-failed",
        "too-large",
        "The response exceeds the 8 MiB read limit. Fetch a narrower resource (an article URL, a page of results) or a raw range from the source."
      )
    case "blocked":
      return fail("blocked", "blocked-target", tail)
    case "not-found":
      return fail("execution-failed", "not-found", `The page was not found (${tail})`)
    case "auth-required":
      return fail(
        "execution-failed",
        "auth-required",
        `The page requires a login or subscription; readers do not use browser sessions (${tail})`
      )
    case "invalid":
      return fail("invalid-arguments", "invalid-url", tail)
    case "unavailable":
      return fail("unsupported-host", "reader-unavailable", tail)
    default:
      return fail(
        "execution-failed",
        "all-readers-failed",
        `No reader produced content (last: ${tail})`
      )
  }
}
