// Capability-routed HTTP GET for the skills.sh marketplace endpoints.
//
// skills.sh and add-skill.vercel.sh send no CORS headers, so a browser
// `fetch` is blocked in plain web mode. Routing:
//   - Tauri desktop  → `skills_fetch_remote_json` Rust proxy (can carry the
//     optional Bearer token; returns non-2xx statuses instead of throwing).
//   - Capacitor      → native CapacitorHttp (bypasses CORS, carries headers).
//   - Web            → direct fetch; a network/CORS failure surfaces as a
//     typed `CorsUnavailableError` so the UI can degrade to registry-only.

import { isTauri } from "@/lib/tauri"
import { skillsFetchRemoteJson } from "@/lib/claude/ipc"
import { getCapacitorHttp } from "@/lib/connectivity/capacitor-http"

const TIMEOUT_MS = 15_000

export interface SkillsHttpResult {
  status: number
  text: string
  retryAfter?: string
}

/** Non-2xx response from a skills.sh endpoint. */
export class SkillsHttpError extends Error {
  readonly status: number
  readonly retryAfter?: string

  constructor(status: number, message: string, retryAfter?: string) {
    super(message)
    this.name = "SkillsHttpError"
    this.status = status
    this.retryAfter = retryAfter
  }
}

/** Web mode cannot reach skills.sh (no CORS headers on their responses). */
export class CorsUnavailableError extends Error {
  constructor() {
    super("skills.sh is not reachable from the browser (CORS); use the desktop or mobile app")
    this.name = "CorsUnavailableError"
  }
}

export interface SkillsHttpOptions {
  bearerToken?: string
  accept?: string
}

/** True when the current runtime has no CORS-free path to skills.sh. */
export function isSkillsShWebBlocked(): boolean {
  return !isTauri() && getCapacitorHttp() === null
}

function findRetryAfter(headers: Record<string, string>): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "retry-after") return value
  }
  return undefined
}

async function getViaTauri(url: string, opts: SkillsHttpOptions): Promise<SkillsHttpResult> {
  const resp = await skillsFetchRemoteJson({
    url,
    bearerToken: opts.bearerToken,
    accept: opts.accept,
  })
  return { status: resp.status, text: resp.body, retryAfter: resp.retryAfter ?? undefined }
}

async function getViaCapacitor(
  cap: NonNullable<ReturnType<typeof getCapacitorHttp>>,
  url: string,
  opts: SkillsHttpOptions
): Promise<SkillsHttpResult> {
  const headers: Record<string, string> = { Accept: opts.accept ?? "application/json" }
  if (opts.bearerToken) headers.Authorization = `Bearer ${opts.bearerToken}`
  const resp = await cap.request({
    url,
    method: "GET",
    headers,
    serverTrustMode: "default",
    connectTimeout: TIMEOUT_MS,
    readTimeout: TIMEOUT_MS,
    responseType: "text",
  })
  // CapacitorHttp may pre-parse JSON bodies despite responseType "text".
  const text = typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data)
  return { status: resp.status, text, retryAfter: findRetryAfter(resp.headers ?? {}) }
}

async function getViaFetch(url: string, opts: SkillsHttpOptions): Promise<SkillsHttpResult> {
  const headers: Record<string, string> = { Accept: opts.accept ?? "application/json" }
  if (opts.bearerToken) headers.Authorization = `Bearer ${opts.bearerToken}`
  let resp: Response
  try {
    resp = await fetch(url, { headers })
  } catch {
    // Browser fetch failures to skills.sh are CORS/network rejections.
    throw new CorsUnavailableError()
  }
  return {
    status: resp.status,
    text: await resp.text(),
    retryAfter: resp.headers.get("retry-after") ?? undefined,
  }
}

/** Raw GET. Non-2xx statuses are RETURNED, not thrown. */
export async function skillsHttpGet(
  url: string,
  opts: SkillsHttpOptions = {}
): Promise<SkillsHttpResult> {
  if (isTauri()) return getViaTauri(url, opts)
  const cap = getCapacitorHttp()
  if (cap) return getViaCapacitor(cap, url, opts)
  return getViaFetch(url, opts)
}

/** JSON GET. Throws `SkillsHttpError` on non-2xx, parse errors on bad JSON. */
export async function skillsHttpGetJson<T>(url: string, opts: SkillsHttpOptions = {}): Promise<T> {
  const result = await skillsHttpGet(url, opts)
  if (result.status < 200 || result.status >= 300) {
    let detail = ""
    try {
      const parsed = JSON.parse(result.text) as { message?: string; error?: string }
      detail = parsed.message ?? parsed.error ?? ""
    } catch {
      detail = result.text.slice(0, 200)
    }
    throw new SkillsHttpError(
      result.status,
      `${url}: http ${result.status}${detail ? ` — ${detail}` : ""}`,
      result.retryAfter
    )
  }
  return JSON.parse(result.text) as T
}
