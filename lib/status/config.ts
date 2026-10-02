/**
 * Where the public status page reads its data, and what it may do there.
 *
 * The same exported `/status` page runs in four places:
 * - `primary`: served by the status Worker at `https://status.cognia.cn/status/`.
 *   The Worker injects a runtime `<meta>` naming its same-origin API.
 * - `mirror`: served by the independent read-only host. Its release script
 *   injects the same `<meta>` with `mode: "mirror"`; signup and token flows
 *   are disabled there whatever the fetched snapshot advertises.
 * - `app`: the route inside Cognia's own export (desktop, mobile, dev server).
 *   No `<meta>` exists, so it reads the official API cross-origin and sends
 *   consent actions to the primary page instead of posting from its origin.
 * - an explicit override (`NEXT_PUBLIC_STATUS_API_URL`) for self-hosters and
 *   local development, passed in by the caller.
 *
 * Leaf module: the caller reads `process.env` / the DOM and passes values in.
 */

import { STATUS_PAGE_URL } from "../constants/external-urls"

export const DEFAULT_STATUS_ORIGIN = "https://status.cognia.cn"
/** The relay host the official status service monitors; nothing else. */
export const OFFICIAL_SIGNALING_HOST = "signaling.cognia.cn"
export const DEFAULT_STATUS_PAGE_URL = STATUS_PAGE_URL
export const STATUS_API_PATH = "/api/status/v1"
export const DEFAULT_STATUS_API_BASE = `${DEFAULT_STATUS_ORIGIN}${STATUS_API_PATH}`
export const STATUS_RUNTIME_META_NAME = "cognia-status-runtime"

export type StatusRuntimeMode = "primary" | "mirror" | "app"

export interface StatusRuntime {
  mode: StatusRuntimeMode
  /** API base with no trailing slash; may be same-origin relative. */
  apiBase: string
  /** The page to send consent actions to when this origin may not post them. */
  primaryPageUrl: string
  /** Signup, confirmation, preference and unsubscribe writes are allowed here. */
  allowsConsentWrites: boolean
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname.endsWith(".localhost")
  )
}

/**
 * HTTPS only, except plain HTTP on a loopback host when development allows
 * it. No credentials in the URL. Returns the normalised URL or null.
 */
export function validateStatusUrl(
  raw: string,
  opts: { allowLoopbackHttp?: boolean } = {}
): string | null {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  if (url.username || url.password) return null
  if (url.protocol === "https:") return url.toString()
  if (url.protocol === "http:" && opts.allowLoopbackHttp && isLoopbackHost(url.hostname)) {
    return url.toString()
  }
  return null
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "")
}

/**
 * Parse the runtime `<meta>` content the Worker or mirror injects. Only a
 * same-origin absolute path is accepted as the API base, so injected HTML
 * cannot point the page at a foreign host.
 */
export function parseStatusRuntimeMeta(
  content: string | null | undefined
): { mode: "primary" | "mirror"; apiBase: string } | null {
  if (!content) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null
  const { mode, apiBase } = parsed as { mode?: unknown; apiBase?: unknown }
  if (mode !== "primary" && mode !== "mirror") return null
  if (
    typeof apiBase !== "string" ||
    !/^\/[A-Za-z0-9/_-]*$/.test(apiBase) ||
    apiBase.includes("//")
  ) {
    return null
  }
  return { mode, apiBase: trimSlash(apiBase) }
}

export interface ResolveStatusRuntimeInput {
  /** Content of `<meta name="cognia-status-runtime">`, if present. */
  metaContent?: string | null
  /** `NEXT_PUBLIC_STATUS_API_URL`, if set at build time. */
  apiOverride?: string | null
  /** `NEXT_PUBLIC_STATUS_PAGE_URL`, if set at build time. */
  pageOverride?: string | null
  /** Development builds may point at a loopback HTTP Worker. */
  allowLoopbackHttp?: boolean
}

export function resolveStatusRuntime(input: ResolveStatusRuntimeInput = {}): StatusRuntime {
  const allowLoopbackHttp = input.allowLoopbackHttp ?? false
  const primaryPageUrl =
    (input.pageOverride && validateStatusUrl(input.pageOverride, { allowLoopbackHttp })) ||
    DEFAULT_STATUS_PAGE_URL
  const meta = parseStatusRuntimeMeta(input.metaContent)
  if (meta) {
    return {
      mode: meta.mode,
      apiBase: meta.apiBase,
      primaryPageUrl,
      allowsConsentWrites: meta.mode === "primary",
    }
  }
  const override = input.apiOverride
    ? validateStatusUrl(input.apiOverride, { allowLoopbackHttp })
    : null
  return {
    mode: "app",
    apiBase: trimSlash(override ?? DEFAULT_STATUS_API_BASE),
    primaryPageUrl,
    allowsConsentWrites: false,
  }
}

/** Join the API base and a path such as `/snapshot?range=24h`. */
export function statusApiUrl(apiBase: string, path: string): string {
  return `${trimSlash(apiBase)}${path.startsWith("/") ? path : `/${path}`}`
}

/** Deep link to one incident on a status page (query ID, static route). */
export function statusIncidentPageUrl(pageUrl: string, incidentId: string): string {
  const url = new URL(pageUrl)
  url.searchParams.set("incident", incidentId)
  url.hash = ""
  return url.toString()
}

/** Token actions carried in the fragment so they never reach server logs. */
export const STATUS_TOKEN_ACTIONS = ["confirm", "manage", "unsubscribe"] as const
export type StatusTokenAction = (typeof STATUS_TOKEN_ACTIONS)[number]

export function statusTokenPageUrl(
  pageUrl: string,
  action: StatusTokenAction,
  token: string
): string {
  const url = new URL(pageUrl)
  url.search = ""
  url.hash = new URLSearchParams({ action, token }).toString()
  return url.toString()
}

/** Read a token action from `location.hash`; null when absent or malformed. */
export function parseStatusTokenFragment(
  hash: string
): { action: StatusTokenAction; token: string } | null {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash)
  const action = params.get("action")
  const token = params.get("token")
  if (!action || !token) return null
  if (!(STATUS_TOKEN_ACTIONS as readonly string[]).includes(action)) return null
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) return null
  return { action: action as StatusTokenAction, token }
}
