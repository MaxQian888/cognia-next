/**
 * Web evidence for a panel candidate (ADR-0188 D26, SAFE-01).
 *
 * A candidate may read public pages and search the web in its one tool round.
 * This module reuses the app's own web tools (`lib/web/web-tools-core.ts`) and
 * tightens them for evidence:
 *
 * - **Every hop is a target.** The shared guard checks the URL the model gave;
 *   a public page that redirects to `169.254.169.254` would sail past it. Here
 *   redirects are followed by hand, and each hop is classified before it is
 *   requested. A private, loopback, link-local or metadata target — first hop
 *   or fifth — is refused and recorded; so is a redirect whose target cannot be
 *   read (an opaque browser redirect). On the desktop the native proxy also
 *   refuses private targets after DNS resolution.
 * - **No opt-out.** The user's "allow private hosts" setting is for their own
 *   chats; a model reading evidence never inherits it.
 * - **No hidden model calls.** The shared tool can distil a page with a
 *   utility model; that call would be unledgered, so evidence never asks for it
 *   (D27). The page's text is the evidence.
 * - **No shared cache.** Evidence is pinned by the hash of what was read now.
 */

import type { FetchGuardReason } from "@cognia/network-guard"

import { evaluateFetchTarget, FetchTargetBlockedError } from "@/lib/web/fetch-guard"

export const MAX_EVIDENCE_REDIRECTS = 3
/** Characters of page text kept as evidence. */
export const WEB_EVIDENCE_MAX_CHARS = 40_000

export type SsrfAuditReason = FetchGuardReason | "redirect-unreadable" | "too-many-redirects"

/** One refused hop. The host and the reason only: a URL can carry secrets in its query. */
export interface SsrfAuditEntry {
  host: string
  reason: SsrfAuditReason
  hop: number
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export class RedirectRefusedError extends FetchTargetBlockedError {
  constructor(
    url: string,
    host: string,
    readonly auditReason: SsrfAuditReason
  ) {
    super(url, host, "private-host")
    this.message = `Refusing to follow a redirect (${auditReason})`
    this.name = "RedirectRefusedError"
  }
}

/**
 * A fetch that follows redirects itself, classifying every hop. `onHop`
 * receives the final URL, so evidence names where its content came from.
 */
export function guardedRedirectFetch(
  base: FetchLike,
  options: {
    audit: (entry: SsrfAuditEntry) => void
    onFinalUrl?: (url: string) => void
    maxRedirects?: number
  }
): FetchLike {
  const maxRedirects = options.maxRedirects ?? MAX_EVIDENCE_REDIRECTS
  return async (input, init) => {
    let current =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const decision = evaluateFetchTarget(current, { allowPrivateHosts: false })
      if (!decision.allowed) {
        options.audit({ host: decision.host ?? "", reason: decision.reason, hop })
        throw new FetchTargetBlockedError(current, decision.host ?? "", decision.reason)
      }
      const response = await base(current, { ...init, redirect: "manual" })
      if (response.type === "opaqueredirect" || response.status === 0) {
        options.audit({ host: decision.host ?? "", reason: "redirect-unreadable", hop })
        throw new RedirectRefusedError(current, decision.host ?? "", "redirect-unreadable")
      }
      if (response.status < 300 || response.status >= 400) {
        options.onFinalUrl?.(current)
        return response
      }
      const location = response.headers.get("location")
      if (!location) {
        options.onFinalUrl?.(current)
        return response
      }
      current = new URL(location, current).toString()
    }
    const last = evaluateFetchTarget(current, { allowPrivateHosts: false })
    options.audit({ host: last.host ?? "", reason: "too-many-redirects", hop: maxRedirects + 1 })
    throw new RedirectRefusedError(current, last.host ?? "", "too-many-redirects")
  }
}

export type WebPageResult =
  | { ok: true; finalUrl: string; title: string | null; content: string; truncated: boolean }
  | {
      ok: false
      code: "SSRF_BLOCKED" | "FETCH_FAILED" | "HTTP_ERROR" | "EMPTY"
      message: string
      audit: SsrfAuditEntry[]
    }

export interface WebSearchHit {
  title: string
  url: string
  snippet: string
}

export interface WebEvidence {
  fetchPage(url: string, signal: AbortSignal): Promise<WebPageResult>
  /** Present only when a search provider is configured. */
  search?: (query: string, signal: AbortSignal) => Promise<WebSearchHit[] | null>
}

type WebFetchFn = typeof import("@/lib/web/web-tools-core").webFetch
type WebSearchFn = typeof import("@/lib/web/web-tools-core").webSearch
type SearchExecutor = import("@/lib/web/web-tools-core").WebSearchDeps["searchExecutor"]

export interface WebEvidenceDeps {
  transport: FetchLike
  webFetch: WebFetchFn
  webSearch?: WebSearchFn
  searchExecutor?: SearchExecutor
  userAgent?: string
}

/** The fields of the shared tool's answer that evidence reads. */
interface WebFetchOutcome {
  ok?: boolean
  code?: string
  status?: number
  text?: string
  body?: string
  title?: string
  truncated?: boolean
}

export function createWebEvidence(deps: WebEvidenceDeps): WebEvidence {
  const evidence: WebEvidence = {
    async fetchPage(url, signal) {
      const audit: SsrfAuditEntry[] = []
      // The shared tool refuses a private first hop itself; decide it here so
      // the refusal is recorded like every later hop.
      const first = evaluateFetchTarget(url, { allowPrivateHosts: false })
      if (!first.allowed) {
        audit.push({ host: first.host ?? "", reason: first.reason, hop: 0 })
        return {
          ok: false,
          code: "SSRF_BLOCKED",
          message: "the target is not a public address",
          audit,
        }
      }
      let finalUrl = url
      const fetchImpl = guardedRedirectFetch(deps.transport, {
        audit: (entry) => audit.push(entry),
        onFinalUrl: (resolved) => {
          finalUrl = resolved
        },
      })
      const raw = (await deps.webFetch(
        { url, format: "text", maxBytes: WEB_EVIDENCE_MAX_CHARS },
        {
          fetchImpl: fetchImpl as typeof fetch,
          signal,
          allowPrivateHosts: false,
          jinaFallback: false,
          alwaysDistill: false,
          ...(deps.userAgent ? { userAgent: deps.userAgent } : {}),
        }
      )) as WebFetchOutcome
      if (audit.length > 0 || raw.code === "blocked") {
        return {
          ok: false,
          code: "SSRF_BLOCKED",
          message: "the target is not a public address",
          audit,
        }
      }
      if (typeof raw.status !== "number") {
        return { ok: false, code: "FETCH_FAILED", message: "the page could not be fetched", audit }
      }
      if (raw.ok === false || raw.status >= 400) {
        return { ok: false, code: "HTTP_ERROR", message: `the page answered ${raw.status}`, audit }
      }
      const content = raw.text ?? raw.body ?? ""
      if (content.trim().length === 0) {
        return { ok: false, code: "EMPTY", message: "the page had no readable text", audit }
      }
      return {
        ok: true,
        finalUrl,
        title: raw.title ?? null,
        content,
        truncated: raw.truncated === true,
      }
    },
  }
  if (deps.webSearch && deps.searchExecutor) {
    const webSearch = deps.webSearch
    const searchExecutor = deps.searchExecutor
    evidence.search = async (query) => {
      const raw = (await webSearch({ query, maxResults: 5 }, { searchExecutor })) as {
        ok?: boolean
        results?: Array<{ title?: unknown; url?: unknown; content?: unknown }>
      }
      if (raw.ok !== true || !Array.isArray(raw.results)) return null
      return raw.results
        .filter((hit) => typeof hit.url === "string")
        .map((hit) => ({
          title: typeof hit.title === "string" ? hit.title : "",
          url: hit.url as string,
          snippet: typeof hit.content === "string" ? hit.content : "",
        }))
    }
  }
  return evidence
}

function isTauriWindow(): boolean {
  return (
    typeof window !== "undefined" &&
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== undefined
  )
}

/**
 * Whether this brain can reach arbitrary public pages with every redirect hop
 * checked: the desktop (native proxy) and a headless Node brain can. A browser
 * tab cannot (CORS, and redirects it will not show), and the mobile HTTP plugin
 * follows redirects natively where no hop can be checked — a panel there is
 * offered no web tools rather than tools that fail or leak.
 */
export function webEvidenceAvailable(): boolean {
  if (typeof window === "undefined") return typeof globalThis.fetch === "function"
  return isTauriWindow()
}

/** The production evidence tools, over the host transport and the search providers chat uses. */
export async function hostWebEvidence(): Promise<WebEvidence | null> {
  if (!webEvidenceAvailable()) return null
  const [{ webFetch, webSearch }, { resolveWebToolDeps }] = await Promise.all([
    import("@/lib/web/web-tools-core"),
    import("@/lib/claude/plugin-tool-ipc"),
  ])
  const shared = await resolveWebToolDeps()
  // The user switched web tools off: a panel gets none either.
  if (shared.enabled === false) return null
  let transport: FetchLike
  if (isTauriWindow()) {
    // Not the chat transport: that one honours the user's "allow private
    // hosts". Evidence always asks the native proxy to refuse them.
    const { createProxyFetch } = await import("@/lib/network/proxy-fetch")
    const proxied = createProxyFetch()
    transport = (input, init) => proxied(input, { ...init, blockPrivateHosts: true })
  } else {
    // A headless brain is a Node process: no WebView CSP, no renderer proxy
    // store, and a fetch that reports redirects instead of hiding them.
    const { createPlatformFetch } = await import("@/lib/network/platform-fetch")
    transport = createPlatformFetch({ kind: "browser" })
  }
  return createWebEvidence({
    transport,
    webFetch,
    webSearch,
    ...(shared.searchExecutor ? { searchExecutor: shared.searchExecutor } : {}),
    ...(shared.userAgent ? { userAgent: shared.userAgent } : {}),
  })
}
