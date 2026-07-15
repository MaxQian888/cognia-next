/**
 * Open VSX registry client — read-only metadata access (ADR pending, plan
 * Phase 2).
 *
 * This module is **the chokepoint between an untrusted registry and the rest
 * of cognia**. Everything downstream (platform resolution, version selection,
 * the cache, and eventually the downloader) consumes only what comes out of
 * here, so every guard that protects the install path has to live at this
 * boundary:
 *
 *   - **zod-validated responses.** The registry is a public, open-publication
 *     service; any publisher controls the strings in their own entry. We parse
 *     into a closed shape rather than trusting field presence.
 *   - **Strict `namespace` / `name`.** Rejected, not escaped — see
 *     `assertRegistryIdComponent` below for why this differs from the manifest
 *     path's escape-don't-reject rule.
 *   - **Host pinning + same-origin `files.download`.** The API hands us the URL
 *     we would later download an executable `.vsix` from. An attacker-supplied
 *     `download` pointing off-site must never be followed.
 *   - **Response size cap + timeout.**
 *
 * ## Field names come from the live API, not the docs
 *
 * The official OpenAPI at `open-vsx.org/v3/api-docs` is **incomplete and
 * wrong**: it omits `/api/-/search` entirely and names the fields
 * `downloads` / `rating` / `ratingCount`. The live responses use
 * `downloadCount` / `averageRating` / `reviewCount` (verified by curl
 * 2026-07-15). This module codes against the live shape; `openvsx-client.test.ts`
 * pins that with `parses_live_field_names_downloadCount_not_downloads` so a
 * future "fix it to match the spec" refactor fails loudly instead of silently
 * reading `undefined` for every download count.
 *
 * `categories` exists **only** on `/query`, never on `/search` — the search
 * entry type reflects that rather than pretending the field is merely optional.
 *
 * Transport is `proxyFetch`, exactly as `lib/plugin/package/marketplace.ts`
 * does it: under Tauri it routes through the Rust backend (no CORS, honours the
 * user's proxy config), in the browser it degrades to plain `fetch`.
 */

import { z } from "zod"
import { proxyFetch } from "@/lib/network/proxy-fetch"
import {
  normalizeOperationError,
  type MarketplaceErrorCategory,
  type MarketplaceOperationError,
} from "@/lib/plugin/package/marketplace"
import { InvalidExtensionIdError, safeIdComponent } from "./extension-id"

// =============================================================================
// Configuration
// =============================================================================

/** The canonical registry. Configurable so a self-hosted mirror can be used. */
export const OPEN_VSX_BASE = "https://open-vsx.org"

export interface OpenVsxClientConfig {
  /** Registry origin. Every fetched URL is pinned to this host. */
  baseUrl: string
  /** Positive-cache TTL in ms. */
  cacheTimeout: number
  /** Hard ceiling on a single response body. */
  maxResponseBytes: number
  /** Per-request timeout in ms. */
  timeoutMs: number
}

const DEFAULT_CONFIG: OpenVsxClientConfig = {
  baseUrl: OPEN_VSX_BASE,
  cacheTimeout: 300_000, // 5 minutes — mirrors PluginMarketplace
  maxResponseBytes: 4 * 1024 * 1024, // 4 MiB — a `size=12` page is ~50 KB
  timeoutMs: 15_000,
}

const MAX_CACHE_SIZE = 100

/**
 * Negative-cache TTL for failed lookups. Same rationale as
 * `PluginMarketplace`'s: one "check for updates" fires a lookup per installed
 * extension, and against an unreachable (or rate-limiting) registry that
 * becomes N identical failures per check. Short enough that a recovering
 * registry is picked up quickly.
 */
const NEGATIVE_CACHE_TTL = 60_000

// =============================================================================
// Errors
// =============================================================================

/**
 * A registry operation failure carrying the shared marketplace error taxonomy.
 *
 * The category mapping is reused from `lib/plugin/package/marketplace.ts`
 * (`normalizeOperationError`) rather than reimplemented, so an Open VSX 429 and
 * a cognia-registry 429 are both `rate_limit` and the UI can treat them
 * identically.
 */
export class OpenVsxError extends Error {
  readonly category: MarketplaceErrorCategory
  readonly retryable: boolean
  readonly status?: number

  constructor(info: MarketplaceOperationError) {
    super(info.message)
    this.name = "OpenVsxError"
    this.category = info.category
    this.retryable = info.retryable
    this.status = info.status
  }
}

function fail(error: unknown, fallbackMessage: string, status?: number): OpenVsxError {
  return new OpenVsxError(normalizeOperationError(error, fallbackMessage, status))
}

function failValidation(message: string): OpenVsxError {
  // Route through the taxonomy by status so the category can't drift from
  // `categoryFromStatus`'s notion of a validation failure.
  return new OpenVsxError(normalizeOperationError(new Error(message), message, 422))
}

// =============================================================================
// Response schemas — shaped from the LIVE API (curl-verified 2026-07-15)
// =============================================================================

/** `{url, namespace, extension}` — Open VSX's `ExtensionReferenceJson`. */
const extensionReferenceSchema = z.object({
  url: z.string().optional(),
  namespace: z.string(),
  extension: z.string(),
})

/**
 * `files` on a **search** result. Verified live to carry exactly:
 * `download, icon, publicKey, sha256, signature`. Notably no `manifest` —
 * that only appears on `/query`.
 *
 * `sha256` is a **URL pointing at the digest file**, not the digest itself.
 */
const searchFilesSchema = z.object({
  download: z.string(),
  signature: z.string().optional(),
  icon: z.string().optional(),
  sha256: z.string().optional(),
  publicKey: z.string().optional(),
})

/**
 * `files` on a **query** result — adds `manifest` (a direct package.json link,
 * which is what lets the UI preview permissions without downloading the
 * `.vsix`), plus `readme` / `license` / `vsixmanifest`.
 */
const queryFilesSchema = searchFilesSchema.extend({
  manifest: z.string().optional(),
  readme: z.string().optional(),
  license: z.string().optional(),
  vsixmanifest: z.string().optional(),
})

/**
 * Fields common to both endpoints.
 *
 * `downloadCount` / `averageRating` / `reviewCount` are the **live** names. The
 * published OpenAPI's `downloads` / `rating` / `ratingCount` are wrong; because
 * zod strips unknown keys, a response using the doc's names parses to
 * `undefined` here rather than silently half-working.
 */
const commonEntryFields = {
  url: z.string().optional(),
  name: z.string(),
  namespace: z.string(),
  version: z.string(),
  timestamp: z.string().optional(),
  verified: z.boolean().optional(),
  averageRating: z.number().optional(),
  reviewCount: z.number().optional(),
  downloadCount: z.number().optional(),
  displayName: z.string().optional(),
  description: z.string().optional(),
  deprecated: z.boolean().optional(),
}

const searchEntrySchema = z.object({
  ...commonEntryFields,
  files: searchFilesSchema,
})

const queryEntrySchema = z.object({
  ...commonEntryFields,
  files: queryFilesSchema,
  targetPlatform: z.string().optional(),
  engines: z.record(z.string(), z.string()).optional(),
  categories: z.array(z.string()).optional(),
  extensionKind: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  dependencies: z.array(extensionReferenceSchema).optional(),
  bundledExtensions: z.array(extensionReferenceSchema).optional(),
  preRelease: z.boolean().optional(),
  versionAlias: z.array(z.string()).optional(),
  downloadable: z.boolean().optional(),
  license: z.string().optional(),
  repository: z.string().optional(),
  homepage: z.string().optional(),
  publishedBy: z.object({ loginName: z.string().optional() }).optional(),
  namespaceAccess: z.string().optional(),
  allVersionsUrl: z.string().optional(),
})

/**
 * Both endpoints share the envelope. A platform miss is **`totalSize: 0`, not
 * an error** — verified: rust-analyzer at `targetPlatform=alpine-arm64` returns
 * an empty list with HTTP 200. That is why the `universal` retry in
 * `openvsx-platform.ts` is required rather than defensive.
 */
const searchResponseSchema = z.object({
  offset: z.number().optional(),
  totalSize: z.number(),
  extensions: z.array(searchEntrySchema),
})

const queryResponseSchema = z.object({
  offset: z.number().optional(),
  totalSize: z.number(),
  extensions: z.array(queryEntrySchema),
})

export type OpenVsxSearchEntry = z.infer<typeof searchEntrySchema>
export type OpenVsxQueryEntry = z.infer<typeof queryEntrySchema>
export type OpenVsxExtensionReference = z.infer<typeof extensionReferenceSchema>

export interface OpenVsxSearchResponse {
  offset: number
  totalSize: number
  extensions: OpenVsxSearchEntry[]
}

export interface OpenVsxQueryResponse {
  offset: number
  totalSize: number
  extensions: OpenVsxQueryEntry[]
}

// =============================================================================
// Trust guards
// =============================================================================

/**
 * Validate a registry-supplied id component — **rejecting** anything that isn't
 * already a clean path segment.
 *
 * This deliberately differs from the manifest path. `safeIdComponent` escapes
 * (`pub@lisher` -> `pub-lisher`) because a local `.vsix` the user chose to
 * install should still install. A *registry* entry is different: Open VSX
 * namespaces are already constrained to a safe alphabet, so anything needing
 * escaping means the response is not what the registry would legitimately
 * serve. Escaping it would coerce a hostile value into a plausible one; we
 * reject instead.
 *
 * The character rule itself is not duplicated — it is `safeIdComponent`'s, and
 * we assert the escape was a no-op. That keeps this in lockstep with the Rust
 * `sanitize_plugin_id_strict` twin for free.
 */
function assertRegistryIdComponent(component: "publisher" | "name", value: string): void {
  // Throws on non-string / empty / over-long.
  const escaped = safeIdComponent(component, value)
  if (escaped !== value) {
    throw new InvalidExtensionIdError(
      component,
      value,
      "contains characters that are not valid in an Open VSX identifier"
    )
  }
}

/**
 * Assert a registry-supplied URL is on the pinned registry host.
 *
 * Applied to `files.download` because that URL leads to executable bytes, and
 * to any URL we fetch ourselves. Note this pins the URL the *API hands us*;
 * the `.vsix` itself later 302s to the CDN, and following that redirect is the
 * downloader's problem (Phase 3), with its own host allowlist.
 */
function assertSameOrigin(baseUrl: string, url: string, field: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw failValidation(`Open VSX returned a malformed ${field} URL: ${JSON.stringify(url)}`)
  }
  const base = new URL(baseUrl)
  if (parsed.origin !== base.origin) {
    throw failValidation(
      `Open VSX returned an off-site ${field} URL (${parsed.origin}); expected ${base.origin}`
    )
  }
}

/**
 * Enforce the trust invariants zod can't express (they depend on the
 * configured base URL, and on the escape rule owned by `extension-id.ts`).
 *
 * A violation rejects the **whole response**, not just the offending entry.
 * Dropping one bad entry would render a page that looks fine while a hostile
 * value is in flight; a legitimate Open VSX response can never trip these, so
 * failing loudly costs real users nothing.
 */
function assertEntryInvariants(
  baseUrl: string,
  entry: { namespace: string; name: string; files: { download: string } }
): void {
  try {
    assertRegistryIdComponent("publisher", entry.namespace)
    assertRegistryIdComponent("name", entry.name)
  } catch (error) {
    if (error instanceof InvalidExtensionIdError) throw failValidation(error.message)
    throw error
  }
  assertSameOrigin(baseUrl, entry.files.download, "files.download")
}

// =============================================================================
// Client
// =============================================================================

interface CacheEntry {
  data: unknown
  timestamp: number
}

export interface OpenVsxSearchOptions {
  query?: string
  category?: string
  size?: number
  offset?: number
  sortBy?: "relevance" | "timestamp" | "downloadCount" | "averageRating"
  sortOrder?: "asc" | "desc"
}

export interface OpenVsxQueryOptions {
  /** Canonical `namespace.name`. */
  extensionId: string
  targetPlatform?: string
  includeAllVersions?: boolean
}

export class OpenVsxClient {
  private config: OpenVsxClientConfig
  private cache = new Map<string, CacheEntry>()
  /** Remembers recent failures (key -> {error, expiry}) to collapse bursts. */
  private missCache = new Map<string, { error: OpenVsxError; expiry: number }>()

  constructor(config: Partial<OpenVsxClientConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Search the registry.
   *
   * Server-side paging only (`size` / `offset`) — never fetch-all.
   */
  async searchExtensions(options: OpenVsxSearchOptions = {}): Promise<OpenVsxSearchResponse> {
    const cacheKey = `search:${JSON.stringify(options)}`
    const cached = this.getFromCache<OpenVsxSearchResponse>(cacheKey)
    if (cached) return cached

    const params = new URLSearchParams()
    if (options.query) params.set("query", options.query)
    if (options.category) params.set("category", options.category)
    if (options.size !== undefined) params.set("size", String(options.size))
    if (options.offset !== undefined) params.set("offset", String(options.offset))
    if (options.sortBy) params.set("sortBy", options.sortBy)
    if (options.sortOrder) params.set("sortOrder", options.sortOrder)

    return this.run(cacheKey, `/api/-/search?${params}`, "Failed to search Open VSX", (payload) => {
      const parsed = this.parse(searchResponseSchema, payload)
      for (const entry of parsed.extensions) {
        assertEntryInvariants(this.config.baseUrl, entry)
      }
      return {
        offset: parsed.offset ?? 0,
        totalSize: parsed.totalSize,
        extensions: parsed.extensions,
      }
    })
  }

  /**
   * Query one extension for the richer metadata (`categories`, `engines`,
   * `preRelease`, `downloadable`, `files.manifest`, …).
   *
   * Returns the envelope rather than a single entry: a platform miss is a
   * legitimate `totalSize: 0` response, and only the caller
   * (`openvsx-platform.ts`) can decide whether to retry with `universal`.
   */
  async queryExtension(options: OpenVsxQueryOptions): Promise<OpenVsxQueryResponse> {
    const cacheKey = `query:${JSON.stringify(options)}`
    const cached = this.getFromCache<OpenVsxQueryResponse>(cacheKey)
    if (cached) return cached

    // Validate before spending a request: the id we send is also the id we'll
    // key rows and directories by.
    const separator = options.extensionId.indexOf(".")
    if (separator <= 0 || separator === options.extensionId.length - 1) {
      throw failValidation(
        `Open VSX extension id must be "namespace.name": ${JSON.stringify(options.extensionId)}`
      )
    }
    try {
      assertRegistryIdComponent("publisher", options.extensionId.slice(0, separator))
      assertRegistryIdComponent("name", options.extensionId.slice(separator + 1))
    } catch (error) {
      if (error instanceof InvalidExtensionIdError) throw failValidation(error.message)
      throw error
    }

    const params = new URLSearchParams({ extensionId: options.extensionId })
    if (options.targetPlatform) params.set("targetPlatform", options.targetPlatform)
    if (options.includeAllVersions !== undefined) {
      params.set("includeAllVersions", String(options.includeAllVersions))
    }

    return this.run(cacheKey, `/api/-/query?${params}`, "Failed to query Open VSX", (payload) => {
      const parsed = this.parse(queryResponseSchema, payload)
      for (const entry of parsed.extensions) {
        assertEntryInvariants(this.config.baseUrl, entry)
      }
      return {
        offset: parsed.offset ?? 0,
        totalSize: parsed.totalSize,
        extensions: parsed.extensions,
      }
    })
  }

  /**
   * Fetch an extension's `package.json` via `files.manifest`.
   *
   * This is what makes an honest permission preview possible before download:
   * the caller gets the real manifest contributions without pulling the whole
   * `.vsix`. The URL is host-pinned — it comes from a registry response.
   *
   * Returns the raw object: interpreting a VS Code `package.json` is
   * `manifest-adapter.ts`'s job, and this module must not become a second
   * place that understands manifests.
   */
  async fetchManifest(url: string): Promise<Record<string, unknown>> {
    assertSameOrigin(this.config.baseUrl, url, "files.manifest")

    const cacheKey = `manifest:${url}`
    const cached = this.getFromCache<Record<string, unknown>>(cacheKey)
    if (cached) return cached

    return this.run(cacheKey, url, "Failed to fetch Open VSX manifest", (payload) => {
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        throw failValidation("Open VSX manifest is not a JSON object")
      }
      return payload as Record<string, unknown>
    })
  }

  /** Drop every cached response and remembered failure. */
  clearCache(): void {
    this.cache.clear()
    this.missCache.clear()
  }

  // ===========================================================================
  // Private
  // ===========================================================================

  /**
   * Shared request pipeline: negative cache -> fetch -> size cap -> JSON ->
   * `validate` -> positive cache. Failures are remembered so a burst of
   * identical lookups costs one round trip.
   */
  private async run<T>(
    cacheKey: string,
    pathOrUrl: string,
    fallbackMessage: string,
    validate: (payload: unknown) => T
  ): Promise<T> {
    const remembered = this.getRecentMiss(cacheKey)
    if (remembered) throw remembered

    try {
      const url = pathOrUrl.startsWith("http")
        ? pathOrUrl
        : `${this.config.baseUrl.replace(/\/+$/, "")}${pathOrUrl}`
      const payload = await this.fetchJson(url, fallbackMessage)
      const result = validate(payload)
      this.setCache(cacheKey, result)
      return result
    } catch (error) {
      const normalized = error instanceof OpenVsxError ? error : fail(error, fallbackMessage)
      this.rememberMiss(cacheKey, normalized)
      throw normalized
    }
  }

  private async fetchJson(url: string, fallbackMessage: string): Promise<unknown> {
    let response: Response
    try {
      response = await proxyFetch(url, {
        timeout: this.config.timeoutMs,
        headers: { accept: "application/json" },
      })
    } catch (error) {
      throw fail(error, fallbackMessage)
    }

    if (!response.ok) {
      // 429 maps to `rate_limit` via the shared taxonomy (the registry
      // advertises `x-ratelimit-limit: 10800`).
      throw fail(
        new Error(`${fallbackMessage}: HTTP ${response.status}`),
        fallbackMessage,
        response.status
      )
    }

    // Cap before reading when the server declares a length — this is the check
    // that actually protects memory.
    const declared = Number(response.headers.get("content-length"))
    if (Number.isFinite(declared) && declared > this.config.maxResponseBytes) {
      throw failValidation(
        `Open VSX response is too large (${declared} bytes > ${this.config.maxResponseBytes})`
      )
    }

    const text = await response.text()
    // Backstop for responses without a `content-length` (chunked). By now the
    // body is already in memory, so this bounds what we *parse*, not what we
    // received. `length` is a UTF-16 unit count, not bytes — close enough for a
    // ceiling, and it can only under-count multi-byte content.
    if (text.length > this.config.maxResponseBytes) {
      throw failValidation(
        `Open VSX response is too large (${text.length} chars > ${this.config.maxResponseBytes})`
      )
    }

    try {
      return JSON.parse(text)
    } catch {
      throw failValidation("Open VSX returned a malformed JSON response")
    }
  }

  private parse<T>(schema: z.ZodType<T>, payload: unknown): T {
    const result = schema.safeParse(payload)
    if (!result.success) {
      const detail = result.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ")
      throw failValidation(`Open VSX returned an unexpected response shape (${detail})`)
    }
    return result.data
  }

  private getFromCache<T>(key: string): T | null {
    const cached = this.cache.get(key)
    if (!cached) return null
    if (Date.now() - cached.timestamp > this.config.cacheTimeout) {
      this.cache.delete(key)
      return null
    }
    return cached.data as T
  }

  private setCache(key: string, data: unknown): void {
    if (this.cache.size >= MAX_CACHE_SIZE) {
      const oldestKey = this.cache.keys().next().value
      if (oldestKey) this.cache.delete(oldestKey)
    }
    this.cache.set(key, { data, timestamp: Date.now() })
  }

  private rememberMiss(cacheKey: string, error: OpenVsxError): void {
    if (this.missCache.size >= MAX_CACHE_SIZE) {
      const oldestKey = this.missCache.keys().next().value
      if (oldestKey) this.missCache.delete(oldestKey)
    }
    this.missCache.set(cacheKey, { error, expiry: Date.now() + NEGATIVE_CACHE_TTL })
  }

  private getRecentMiss(cacheKey: string): OpenVsxError | null {
    const remembered = this.missCache.get(cacheKey)
    if (!remembered) return null
    if (Date.now() > remembered.expiry) {
      this.missCache.delete(cacheKey)
      return null
    }
    return remembered.error
  }
}

// =============================================================================
// Singleton
// =============================================================================

let clientInstance: OpenVsxClient | null = null

/** Shared client. Mirrors `getPluginMarketplace()`. */
export function getOpenVsxClient(config?: Partial<OpenVsxClientConfig>): OpenVsxClient {
  if (!clientInstance) {
    clientInstance = new OpenVsxClient(config)
  }
  return clientInstance
}

/** Drop the shared client (tests, and config changes such as a mirror URL). */
export function resetOpenVsxClient(): void {
  clientInstance = null
}
