"use client"

/**
 * Client for the signed update catalog.
 *
 * Three things happen here and nowhere else: the request is shaped so it
 * carries no identity beyond a rollout bucket, the response is verified
 * against the compiled-in root before a single byte of it is believed, and the
 * anti-rollback version high-water mark is persisted device-locally so a
 * replayed older catalog is refused forever after.
 */

import type { UpdateChannel } from "@cognia/agent-config-types"

import { APP_VERSION } from "@/lib/app-version"
import { createPlatformFetch } from "@/lib/network/platform-fetch"
import { detectOsFamily } from "@/lib/platform/os"

import type { CatalogEntry, CatalogTrustState, SignedCatalog } from "./catalog-types"
import { verifySignedCatalog } from "./catalog-verify"
import { parseRetryAfter } from "./backoff"
import { compiledTrustRoot, initialTrustState } from "./trust-root"

export const DEFAULT_CATALOG_URL = "https://update.cognia.cn"

const TRUST_STORAGE_KEY = "cognia.update.trust.v1"

export interface CatalogTrustStore {
  read(): CatalogTrustState | null
  write(state: CatalogTrustState): void
}

/**
 * Device-local trust state. Deliberately NOT in AppSettings: the high-water
 * mark is an anti-rollback control, and syncing it between devices would let a
 * restored backup reopen the window it exists to close.
 */
export function localStorageTrustStore(): CatalogTrustStore {
  return {
    read() {
      try {
        const raw = globalThis.localStorage?.getItem(TRUST_STORAGE_KEY)
        if (!raw) return null
        const parsed = JSON.parse(raw) as CatalogTrustState
        return parsed?.root?._type === "root" ? parsed : null
      } catch {
        return null
      }
    },
    write(state) {
      try {
        globalThis.localStorage?.setItem(TRUST_STORAGE_KEY, JSON.stringify(state))
      } catch {
        // A device with storage disabled still verifies every response. It
        // just cannot remember the high-water mark between launches.
      }
    },
  }
}

export interface CatalogClientDeps {
  fetchImpl?: typeof fetch
  trustStore?: CatalogTrustStore
  catalogUrl?: string
  appVersion?: string
  platform?: string
  arch?: string
  now?: () => number
  timeoutMs?: number
  onError?: (error: unknown) => void
}

export interface CatalogResponse {
  entries: readonly CatalogEntry[]
  retryAfterMs?: number
}

function currentPlatform(): string {
  const family = detectOsFamily()
  return family === "unknown" ? "unknown" : family
}

/**
 * Fetch and verify the catalog. Returns null when the control plane is
 * unavailable or the response fails verification, which every adapter treats
 * as "fall back to my own source", never as "assume nothing changed".
 */
export async function fetchVerifiedCatalog(
  options: { channel: UpdateChannel; rolloutBucket: number; signal?: AbortSignal },
  deps: CatalogClientDeps = {}
): Promise<CatalogResponse | null> {
  const root = compiledTrustRoot()
  if (!root) return null

  const trustStore = deps.trustStore ?? localStorageTrustStore()
  const stored = trustStore.read()
  // A stored root older than the compiled-in one is a downgrade attempt.
  const trust: CatalogTrustState =
    stored && stored.root.version >= root.version
      ? stored
      : (initialTrustState(root) as CatalogTrustState)

  const base = (deps.catalogUrl ?? DEFAULT_CATALOG_URL).replace(/\/+$/, "")
  const url = new URL(`${base}/v1/catalog`)
  url.searchParams.set("channel", options.channel)
  url.searchParams.set("platform", deps.platform ?? currentPlatform())
  url.searchParams.set("appVersion", deps.appVersion ?? APP_VERSION)
  url.searchParams.set("bucket", String(options.rolloutBucket))
  if (deps.arch) url.searchParams.set("arch", deps.arch)

  // Routed through the platform transport, not a bare `fetch`: on the desktop
  // that carries the user's configured proxy, and in the Capacitor shell it is
  // the only leg that reaches a non-CORS host at all.
  const fetchImpl = deps.fetchImpl ?? createPlatformFetch()
  if (!fetchImpl) return null

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), deps.timeoutMs ?? 30_000)
  options.signal?.addEventListener("abort", () => controller.abort(), { once: true })

  try {
    const response = await fetchImpl(url.toString(), {
      method: "GET",
      signal: controller.signal,
      headers: { accept: "application/json" },
      // No cookies, no credentials. The catalog must not be able to correlate
      // a check with a session.
      credentials: "omit",
      cache: "no-store",
    })
    const now = (deps.now ?? Date.now)()
    const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"), now)
    if (response.status === 304 || response.status === 204) return { entries: [], retryAfterMs }
    if (!response.ok) {
      deps.onError?.(new Error(`catalog http ${response.status}`))
      return retryAfterMs === undefined ? null : { entries: [], retryAfterMs }
    }
    const payload = (await response.json()) as SignedCatalog
    const verified = await verifySignedCatalog(payload, trust, now)
    trustStore.write(verified.trust)
    return { entries: verified.targets.entries, retryAfterMs }
  } catch (error) {
    deps.onError?.(error)
    return null
  } finally {
    clearTimeout(timeout)
  }
}
