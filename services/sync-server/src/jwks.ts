/**
 * The issuer's JWKS, cached per isolate. Fetched through the `IDENTITY`
 * service binding when there is one (no public round trip), otherwise from
 * `${issuer}/jwks`. A token signed with a key the cache does not know forces
 * one refetch, at most once a minute, so a key rotation is picked up at once
 * without letting junk tokens hammer the issuer.
 */

import type { JSONWebKeySet } from "jose"

export const JWKS_TTL_MS = 10 * 60 * 1000
export const JWKS_MIN_REFRESH_MS = 60 * 1000

export type FetchJwks = () => Promise<Response>

export interface JwksCache {
  get(): Promise<JSONWebKeySet>
  /** Refetch now unless that happened within the last minute; true if it did. */
  refresh(): Promise<boolean>
}

function isJwks(value: unknown): value is JSONWebKeySet {
  return (
    typeof value === "object" && value !== null && Array.isArray((value as { keys?: unknown }).keys)
  )
}

export function createJwksCache(fetchJwks: FetchJwks, now: () => number = Date.now): JwksCache {
  let cached: { jwks: JSONWebKeySet; fetchedAt: number } | null = null
  let inflight: Promise<JSONWebKeySet> | null = null

  async function load(): Promise<JSONWebKeySet> {
    if (!inflight) {
      inflight = (async () => {
        const response = await fetchJwks()
        if (!response.ok) throw new Error(`the issuer's JWKS answered ${response.status}`)
        const body: unknown = await response.json()
        if (!isJwks(body)) throw new Error("the issuer's JWKS is malformed")
        cached = { jwks: body, fetchedAt: now() }
        return body
      })().finally(() => {
        inflight = null
      })
    }
    return inflight
  }

  return {
    async get() {
      if (cached && now() - cached.fetchedAt < JWKS_TTL_MS) return cached.jwks
      return load()
    },
    async refresh() {
      if (cached && now() - cached.fetchedAt < JWKS_MIN_REFRESH_MS) return false
      await load()
      return true
    },
  }
}

export function jwksFetcher(issuer: string, identity: Fetcher | undefined): FetchJwks {
  const url = `${issuer}/jwks`
  return () => (identity ? identity.fetch(url) : fetch(url))
}
