/**
 * Plugin Marketplace Infrastructure
 *
 * Provides plugin discovery, installation, update, and dependency management.
 */

import type {
  ExtensionDescriptor,
  PluginManifest,
  PluginResolvedIcon,
  PluginSource,
} from "@/types/plugin"
import { proxyFetch } from "@/lib/network/proxy-fetch"
import { isTauri } from "@/lib/native/utils"
import { loggers } from "../core/logger"
import { buildExtensionDescriptor } from "../core/descriptor"
import { validatePluginManifest } from "../core/validation"
import { compareVersions, satisfiesConstraint } from "./dependency-resolver"
import { resolvePluginIcon } from "../icon"
import { getPluginSignatureVerifier } from "../security/signature"
import { recordSilentFailure } from "../contracts/diagnostics-store"

// =============================================================================
// Types
// =============================================================================

/**
 * Plugin registry entry
 */
export interface PluginRegistryEntry {
  id: string
  name: string
  description: string
  author: string
  version: string
  latestVersion: string
  repository?: string
  homepage?: string
  downloads: number
  rating: number
  ratingCount: number
  tags: string[]
  categories: string[]
  manifest: PluginManifest
  publishedAt: Date
  updatedAt: Date
  verified: boolean
  featured: boolean
  downloadUrl?: string
  checksum?: string
  icon?: string
  resolvedIcon?: PluginResolvedIcon
  source?: PluginSource | "marketplace"
  descriptor?: ExtensionDescriptor
}

/**
 * Plugin search options
 */
export interface PluginSearchOptions {
  query?: string
  category?: string
  tags?: string[]
  sortBy?: "downloads" | "rating" | "updated" | "name"
  sortOrder?: "asc" | "desc"
  verified?: boolean
  featured?: boolean
  limit?: number
  offset?: number
}

/**
 * Plugin search result
 */
export interface PluginSearchResult {
  plugins: PluginRegistryEntry[]
  total: number
  hasMore: boolean
}

/**
 * Plugin version info
 */
export interface PluginVersionInfo {
  version: string
  changelog?: string
  publishedAt: Date
  minAppVersion?: string
  downloadUrl: string
  checksum?: string
}

/**
 * Plugin dependency
 */
export interface PluginDependency {
  id: string
  version: string
  optional: boolean
}

/**
 * Dependency resolution result
 */
export interface DependencyResolutionResult {
  resolved: boolean
  dependencies: PluginDependency[]
  conflicts: { pluginId: string; required: string; available: string }[]
  missing: string[]
}

/**
 * Installation progress
 */
export interface InstallationProgress {
  pluginId: string
  stage:
    | "downloading"
    | "extracting"
    | "installing"
    | "configuring"
    | "complete"
    | "error"
    | "copy"
    | "validate"
    | "register"
    | "done"
  progress: number
  message: string
  error?: string
}

export type MarketplaceErrorCategory =
  | "network"
  | "auth"
  | "rate_limit"
  | "validation"
  | "unsupported_env"
  | "install_conflict"
  | "signature_invalid"
  | "unknown"

export interface MarketplaceOperationError {
  category: MarketplaceErrorCategory
  message: string
  retryable: boolean
  code?: string
  status?: number
}

export interface PluginInstallResult {
  success: boolean
  descriptor?: ExtensionDescriptor
  error?: string
  errorCategory?: MarketplaceErrorCategory
  retryable?: boolean
}

interface PluginDownloadVersionResult {
  success: boolean
  pluginId?: string
  version?: string
  downloadUrl?: string
  errorCode?: string
  error?: string
  retryable?: boolean
}

type InstallOperation = "install" | "update"

// =============================================================================
// Plugin Marketplace Client
// =============================================================================

/**
 * Marketplace configuration
 */
export interface MarketplaceConfig {
  registryUrl: string
  cacheTimeout: number
  verifySignatures: boolean
}

const DEFAULT_CONFIG: MarketplaceConfig = {
  registryUrl: "https://plugins.cognia.app/api/v1",
  cacheTimeout: 300000, // 5 minutes
  verifySignatures: true,
}

const MAX_CACHE_SIZE = 100

const RETRYABLE_CATEGORIES = new Set<MarketplaceErrorCategory>(["network", "rate_limit"])

function parseDate(value: unknown): Date {
  if (value instanceof Date) return value
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) return parsed
  }
  return new Date(0)
}

function normalizeRegistryEntry(raw: unknown): PluginRegistryEntry {
  const entry = (raw || {}) as Record<string, unknown>
  const rawIcon =
    typeof entry.icon === "string"
      ? entry.icon
      : typeof (entry.manifest as Record<string, unknown> | undefined)?.icon === "string"
        ? String((entry.manifest as Record<string, unknown>).icon)
        : undefined
  return {
    id: String(entry.id || ""),
    name: String(entry.name || ""),
    description: String(entry.description || ""),
    author: String(entry.author || ""),
    version: String(entry.version || "0.0.0"),
    latestVersion: String(entry.latestVersion || entry.latest_version || entry.version || "0.0.0"),
    repository: typeof entry.repository === "string" ? entry.repository : undefined,
    homepage: typeof entry.homepage === "string" ? entry.homepage : undefined,
    downloads: Number(entry.downloads || 0),
    rating: Number(entry.rating || 0),
    ratingCount: Number(entry.ratingCount || entry.rating_count || 0),
    tags: Array.isArray(entry.tags) ? entry.tags.map(String) : [],
    categories: Array.isArray(entry.categories) ? entry.categories.map(String) : [],
    manifest: (entry.manifest || {}) as PluginManifest,
    publishedAt: parseDate(entry.publishedAt || entry.published_at),
    updatedAt: parseDate(entry.updatedAt || entry.updated_at),
    verified: Boolean(entry.verified),
    featured: Boolean(entry.featured),
    downloadUrl:
      typeof entry.downloadUrl === "string"
        ? entry.downloadUrl
        : typeof entry.download_url === "string"
          ? entry.download_url
          : undefined,
    checksum: typeof entry.checksum === "string" ? entry.checksum : undefined,
    icon: rawIcon,
    resolvedIcon:
      (entry.resolvedIcon as PluginResolvedIcon | undefined) ||
      resolvePluginIcon({ icon: rawIcon }),
    source:
      typeof entry.source === "string"
        ? (entry.source as PluginRegistryEntry["source"])
        : "marketplace",
    descriptor: entry.descriptor as ExtensionDescriptor | undefined,
  }
}

function normalizeLocalPath(basePath: string, child: string): string {
  return `${basePath.replace(/[\\/]+$/, "")}/${child}`.replace(
    /\//g,
    basePath.includes("\\") ? "\\" : "/"
  )
}

function createLocalRegistryEntry(
  manifest: PluginManifest,
  pluginPath: string,
  installedVersion?: string,
  icon?: string,
  resolvedIcon?: PluginResolvedIcon
): PluginRegistryEntry {
  const localVersion = manifest.version || "0.0.0"
  const currentVersion =
    installedVersion && compareVersions(installedVersion, localVersion) <= 0
      ? installedVersion
      : localVersion

  return {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description || "",
    author: typeof manifest.author === "object" ? manifest.author?.name || "" : "",
    version: currentVersion,
    latestVersion: localVersion,
    repository: manifest.repository,
    homepage: manifest.homepage,
    downloads: 0,
    rating: 0,
    ratingCount: 0,
    tags: Array.isArray(manifest.keywords) ? manifest.keywords : [],
    categories: [...(manifest.capabilities || [])],
    manifest,
    publishedAt: new Date(0),
    updatedAt: new Date(),
    verified: false,
    featured: false,
    icon,
    resolvedIcon,
    source: "local",
    descriptor: buildExtensionDescriptor({
      manifest,
      source: "local",
      path: pluginPath,
      pluginDirectory: pluginPath,
      installRootKind: "installed",
    }),
  }
}

export class LocalPluginSource {
  async scan(
    pluginDirectory: string,
    installedPlugins: { id: string; version: string }[] = []
  ): Promise<PluginRegistryEntry[]> {
    if (!pluginDirectory || !isTauri()) {
      return []
    }

    try {
      const { exists, readDir, readTextFile } = await import("@tauri-apps/plugin-fs")
      const directoryExists = await exists(pluginDirectory).catch(() => false)
      if (!directoryExists) {
        loggers.marketplace.info(`Local plugin directory not available: ${pluginDirectory}`)
        return []
      }

      const installedVersions = new Map(
        installedPlugins.map((plugin) => [plugin.id, plugin.version])
      )
      const entries = await readDir(pluginDirectory)
      const results: PluginRegistryEntry[] = []

      for (const entry of entries) {
        if (!entry?.isDirectory) {
          continue
        }

        const entryPath = normalizeLocalPath(pluginDirectory, entry.name)

        const manifestCandidates = [
          normalizeLocalPath(entryPath, "plugin.json"),
          normalizeLocalPath(entryPath, "manifest.json"),
          normalizeLocalPath(entryPath, "package.json"),
        ]

        let manifestPath: string | null = null
        for (const candidate of manifestCandidates) {
          if (await exists(candidate).catch(() => false)) {
            manifestPath = candidate
            break
          }
        }

        if (!manifestPath) {
          continue
        }

        try {
          const rawManifest = await readTextFile(manifestPath)
          const manifest = JSON.parse(rawManifest) as PluginManifest
          const validation = validatePluginManifest(manifest)
          if (!validation.valid) {
            loggers.marketplace.warn(
              `Skipping invalid local plugin manifest at ${manifestPath}: ${validation.errors.join(", ")}`
            )
            continue
          }

          let resolvedIcon = resolvePluginIcon({
            icon: manifest.icon,
            pluginRoot: entryPath,
          })
          if (resolvedIcon?.kind === "image" && resolvedIcon.transport === "file") {
            const iconExists = await exists(resolvedIcon.src).catch(() => false)
            if (!iconExists) {
              resolvedIcon = {
                kind: "fallback",
                original: manifest.icon,
                reason: "missing",
              }
            }
          }

          results.push(
            createLocalRegistryEntry(
              manifest,
              entryPath,
              installedVersions.get(manifest.id),
              manifest.icon,
              resolvedIcon
            )
          )
        } catch (error) {
          loggers.marketplace.warn(
            `Skipping unreadable local plugin at ${entryPath}:`,
            error as Error
          )
        }
      }

      return results
    } catch (error) {
      loggers.marketplace.warn(
        `Failed to scan local plugin source ${pluginDirectory}:`,
        error as Error
      )
      return []
    }
  }
}

function normalizeVersionInfo(raw: unknown): PluginVersionInfo {
  const value = (raw || {}) as Record<string, unknown>
  return {
    version: String(value.version || "0.0.0"),
    changelog: typeof value.changelog === "string" ? value.changelog : undefined,
    publishedAt: parseDate(value.publishedAt || value.published_at),
    minAppVersion:
      typeof value.minAppVersion === "string"
        ? value.minAppVersion
        : typeof value.min_app_version === "string"
          ? value.min_app_version
          : undefined,
    downloadUrl: String(value.downloadUrl || value.download_url || ""),
    checksum: typeof value.checksum === "string" ? value.checksum : undefined,
  }
}

function categoryFromStatus(status: number): MarketplaceErrorCategory {
  if (status === 401 || status === 403) return "auth"
  if (status === 429) return "rate_limit"
  if (status === 400 || status === 404 || status === 422) return "validation"
  if (status === 409) return "install_conflict"
  if (status >= 500) return "network"
  return "unknown"
}

function categoryFromMessage(message: string): MarketplaceErrorCategory {
  const lower = message.toLowerCase()
  if (lower.includes("not supported") || lower.includes("desktop app")) return "unsupported_env"
  if (lower.includes("unauthorized") || lower.includes("forbidden") || lower.includes("auth")) {
    return "auth"
  }
  if (lower.includes("429") || lower.includes("rate")) return "rate_limit"
  if (
    lower.includes("network") ||
    lower.includes("timeout") ||
    lower.includes("econn") ||
    lower.includes("enotfound") ||
    lower.includes("proxy request failed") ||
    lower.includes("failed to fetch")
  ) {
    return "network"
  }
  if (
    lower.includes("invalid") ||
    lower.includes("validation") ||
    lower.includes("not found") ||
    lower.includes("bad request")
  ) {
    return "validation"
  }
  if (lower.includes("conflict") || lower.includes("already exists")) return "install_conflict"
  return "unknown"
}

function normalizeOperationError(
  error: unknown,
  fallbackMessage: string,
  status?: number
): MarketplaceOperationError {
  const message = error instanceof Error ? error.message : String(error || fallbackMessage)
  const statusCategory = typeof status === "number" ? categoryFromStatus(status) : null
  const category = statusCategory || categoryFromMessage(message)
  return {
    category,
    message,
    retryable: RETRYABLE_CATEGORIES.has(category),
    status,
  }
}

function normalizeDownloadVersionResult(
  payload: unknown,
  pluginId: string,
  version: string
): PluginDownloadVersionResult {
  const value = (payload || {}) as Record<string, unknown>
  if (typeof value.success === "boolean") {
    return {
      success: value.success,
      pluginId: typeof value.pluginId === "string" ? value.pluginId : pluginId,
      version: typeof value.version === "string" ? value.version : version,
      downloadUrl: typeof value.downloadUrl === "string" ? value.downloadUrl : undefined,
      errorCode: typeof value.errorCode === "string" ? value.errorCode : undefined,
      error: typeof value.error === "string" ? value.error : undefined,
      retryable: typeof value.retryable === "boolean" ? value.retryable : undefined,
    }
  }

  // Backward-compatible interpretation for legacy command responses.
  if (typeof value.error === "string") {
    return {
      success: false,
      pluginId,
      version,
      error: value.error,
    }
  }

  return {
    success: true,
    pluginId,
    version,
    downloadUrl: typeof value.downloadUrl === "string" ? value.downloadUrl : undefined,
  }
}

/**
 * Plugin Marketplace Client
 */
export class PluginMarketplace {
  private config: MarketplaceConfig
  private cache: Map<string, { data: unknown; timestamp: number }> = new Map()
  private installListeners: Map<string, (progress: InstallationProgress) => void> = new Map()

  constructor(config: Partial<MarketplaceConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Strict search for plugins.
   * Throws on transport or HTTP failures.
   */
  async searchPluginsStrict(options: PluginSearchOptions = {}): Promise<PluginSearchResult> {
    const cacheKey = `search:${JSON.stringify(options)}`
    const cached = this.getFromCache<PluginSearchResult>(cacheKey)
    if (cached) return cached

    const params = new URLSearchParams()
    if (options.query) params.set("q", options.query)
    if (options.category) params.set("category", options.category)
    if (options.tags?.length) params.set("tags", options.tags.join(","))
    if (options.sortBy) params.set("sort", options.sortBy)
    if (options.sortOrder) params.set("order", options.sortOrder)
    if (options.verified !== undefined) params.set("verified", String(options.verified))
    if (options.featured !== undefined) params.set("featured", String(options.featured))
    if (options.limit) params.set("limit", String(options.limit))
    if (options.offset) params.set("offset", String(options.offset))

    let response: Response
    try {
      response = await proxyFetch(`${this.config.registryUrl}/plugins?${params}`)
    } catch (error) {
      throw normalizeOperationError(error, "Failed to search plugins")
    }

    if (!response.ok) {
      throw normalizeOperationError(
        new Error(`Failed to search plugins: HTTP ${response.status}`),
        "Failed to search plugins",
        response.status
      )
    }

    const payload = await response.json()
    const rawPlugins = Array.isArray(payload?.plugins) ? payload.plugins : []
    const result: PluginSearchResult = {
      plugins: rawPlugins.map(normalizeRegistryEntry),
      total: Number(payload?.total || 0),
      hasMore: Boolean(payload?.hasMore || payload?.has_more),
    }
    this.setCache(cacheKey, result)
    return result
  }

  /**
   * Search for plugins.
   * Returns empty result on errors for backwards compatibility.
   */
  async searchPlugins(options: PluginSearchOptions = {}): Promise<PluginSearchResult> {
    try {
      return await this.searchPluginsStrict(options)
    } catch (error) {
      loggers.marketplace.error("Search failed:", error as Error)
      return { plugins: [], total: 0, hasMore: false }
    }
  }

  /**
   * Get plugin details
   */
  async getPlugin(pluginId: string): Promise<PluginRegistryEntry | null> {
    const cacheKey = `plugin:${pluginId}`
    const cached = this.getFromCache<PluginRegistryEntry>(cacheKey)
    if (cached) return cached

    let response: Response
    try {
      response = await proxyFetch(`${this.config.registryUrl}/plugins/${pluginId}`)
    } catch (error) {
      loggers.marketplace.error("Get plugin failed:", error as Error)
      return null
    }

    if (!response.ok) {
      if (response.status === 404) return null
      loggers.marketplace.error("Get plugin failed: HTTP", new Error(String(response.status)))
      return null
    }

    const plugin = normalizeRegistryEntry(await response.json())
    this.setCache(cacheKey, plugin)
    return plugin
  }

  /**
   * Get available versions for a plugin.
   * Uses compatibility command in desktop mode when available.
   */
  async getVersions(pluginId: string): Promise<PluginVersionInfo[]> {
    const cacheKey = `versions:${pluginId}`
    const cached = this.getFromCache<PluginVersionInfo[]>(cacheKey)
    if (cached) return cached

    try {
      let payload: unknown

      if (isTauri()) {
        const { invoke } = await import("@tauri-apps/api/core")
        payload = await invoke<unknown>("plugin_marketplace_versions", { pluginId })
      } else {
        const response = await proxyFetch(`${this.config.registryUrl}/plugins/${pluginId}/versions`)
        if (!response.ok) {
          throw normalizeOperationError(
            new Error(`Failed to get versions: HTTP ${response.status}`),
            "Failed to get versions",
            response.status
          )
        }
        payload = await response.json()
      }

      const entries = Array.isArray(payload) ? payload : []
      const versions = entries
        .map(normalizeVersionInfo)
        .filter((entry) => entry.downloadUrl.length > 0)
      this.setCache(cacheKey, versions)
      return versions
    } catch (error) {
      loggers.marketplace.error("Get versions failed:", error as Error)
      return []
    }
  }

  /**
   * Get featured plugins
   */
  async getFeaturedPlugins(): Promise<PluginRegistryEntry[]> {
    const result = await this.searchPlugins({ featured: true, limit: 10 })
    return result.plugins
  }

  /**
   * Get popular plugins
   */
  async getPopularPlugins(limit = 10): Promise<PluginRegistryEntry[]> {
    const result = await this.searchPlugins({ sortBy: "downloads", sortOrder: "desc", limit })
    return result.plugins
  }

  /**
   * Get recently updated plugins
   */
  async getRecentPlugins(limit = 10): Promise<PluginRegistryEntry[]> {
    const result = await this.searchPlugins({ sortBy: "updated", sortOrder: "desc", limit })
    return result.plugins
  }

  /**
   * Get plugin categories
   */
  async getCategories(): Promise<{ id: string; name: string; count: number }[]> {
    const cacheKey = "categories"
    const cached = this.getFromCache<{ id: string; name: string; count: number }[]>(cacheKey)
    if (cached) return cached

    try {
      const response = await proxyFetch(`${this.config.registryUrl}/categories`)
      if (!response.ok) throw new Error(`Failed to get categories: HTTP ${response.status}`)

      const categories = await response.json()
      const normalized = Array.isArray(categories)
        ? categories.map((item) => ({
            id: String(item?.id || ""),
            name: String(item?.name || ""),
            count: Number(item?.count || 0),
          }))
        : []
      this.setCache(cacheKey, normalized)
      return normalized
    } catch (error) {
      loggers.marketplace.error("Get categories failed:", error as Error)
      return []
    }
  }

  /**
   * Resolve dependencies for a plugin
   */
  async resolveDependencies(
    pluginId: string,
    _version?: string
  ): Promise<DependencyResolutionResult> {
    try {
      const plugin = await this.getPlugin(pluginId)
      if (!plugin) {
        return {
          resolved: false,
          dependencies: [],
          conflicts: [],
          missing: [pluginId],
        }
      }

      const dependencies: PluginDependency[] = []
      const conflicts: { pluginId: string; required: string; available: string }[] = []
      const missing: string[] = []

      // Check manifest dependencies
      if (plugin.manifest.dependencies) {
        for (const [depId, depVersion] of Object.entries(plugin.manifest.dependencies)) {
          const depPlugin = await this.getPlugin(depId)
          if (!depPlugin) {
            missing.push(depId)
          } else if (!satisfiesConstraint(depPlugin.latestVersion, depVersion)) {
            conflicts.push({
              pluginId: depId,
              required: depVersion,
              available: depPlugin.latestVersion,
            })
          } else {
            dependencies.push({
              id: depId,
              version: depPlugin.latestVersion,
              optional: false,
            })
          }
        }
      }

      return {
        resolved: missing.length === 0 && conflicts.length === 0,
        dependencies,
        conflicts,
        missing,
      }
    } catch (error) {
      loggers.marketplace.error("Resolve dependencies failed:", error as Error)
      return {
        resolved: false,
        dependencies: [],
        conflicts: [],
        missing: [pluginId],
      }
    }
  }

  /**
   * Subscribe to installation progress
   */
  onInstallProgress(
    pluginId: string,
    listener: (progress: InstallationProgress) => void
  ): () => void {
    this.installListeners.set(pluginId, listener)
    return () => {
      this.installListeners.delete(pluginId)
    }
  }

  /**
   * Emit installation progress
   */
  private emitProgress(progress: InstallationProgress) {
    const listener = this.installListeners.get(progress.pluginId)
    if (listener) {
      listener(progress)
    }
  }

  /**
   * Install a plugin from the marketplace
   */
  async installPlugin(
    pluginId: string,
    version?: string,
    options: { installDependencies?: boolean; operation?: InstallOperation } = {}
  ): Promise<PluginInstallResult> {
    const operation = options.operation || "install"
    try {
      // Emit initial progress
      this.emitProgress({
        pluginId,
        stage: "downloading",
        progress: 0,
        message: operation === "update" ? "Starting update..." : "Starting download...",
      })

      // Resolve dependencies first
      if (options.installDependencies !== false) {
        const deps = await this.resolveDependencies(pluginId, version)
        if (!deps.resolved) {
          return {
            success: false,
            error: `Dependency resolution failed: Missing: ${deps.missing.join(", ")}`,
            errorCategory: "validation",
            retryable: false,
          }
        }

        // Install dependencies first
        for (const dep of deps.dependencies) {
          const depResult = await this.installPlugin(dep.id, dep.version, {
            installDependencies: false,
            operation: "install",
          })
          if (!depResult.success) {
            return {
              success: false,
              error: `Failed to install dependency ${dep.id}: ${depResult.error}`,
              errorCategory: depResult.errorCategory || "install_conflict",
              retryable: depResult.retryable,
            }
          }
        }
      }

      // Get plugin info
      const plugin = await this.getPlugin(pluginId)
      if (!plugin) {
        return {
          success: false,
          error: "Plugin not found",
          errorCategory: "validation",
          retryable: false,
        }
      }

      // Get version info
      const versions = await this.getVersions(pluginId)
      const targetVersion = version ? versions.find((v) => v.version === version) : versions[0]

      if (!targetVersion) {
        return {
          success: false,
          error: version
            ? `Version ${version} not found for plugin ${pluginId}`
            : "Version not found",
          errorCategory: "validation",
          retryable: false,
        }
      }

      this.emitProgress({
        pluginId,
        stage: "downloading",
        progress: 30,
        message:
          operation === "update"
            ? `Preparing update ${plugin.name} -> v${targetVersion.version}...`
            : `Downloading ${plugin.name} v${targetVersion.version}...`,
      })

      // Installation and updates are desktop-only.
      if (!isTauri()) {
        const unsupportedError = normalizeOperationError(
          new Error("Plugin installation requires the Cognia desktop app"),
          "Plugin installation requires the Cognia desktop app"
        )
        this.emitProgress({
          pluginId,
          stage: "error",
          progress: 0,
          message: unsupportedError.message,
          error: unsupportedError.message,
        })
        return {
          success: false,
          error: unsupportedError.message,
          errorCategory: unsupportedError.category,
          retryable: unsupportedError.retryable,
        }
      }

      const { invoke } = await import("@tauri-apps/api/core")
      const pluginDir = await invoke<string>("plugin_get_directory")

      this.emitProgress({
        pluginId,
        stage: "installing",
        progress: 55,
        message:
          operation === "update" ? `Updating ${plugin.name}...` : `Installing ${plugin.name}...`,
      })

      if (version) {
        const downloadResultPayload = await invoke<unknown>("plugin_download_version", {
          pluginId,
          version: targetVersion.version,
        })
        const downloadResult = normalizeDownloadVersionResult(
          downloadResultPayload,
          pluginId,
          targetVersion.version
        )
        if (!downloadResult.success) {
          const errorInfo = normalizeOperationError(
            new Error(downloadResult.error || "Version download failed"),
            "Version download failed"
          )
          this.emitProgress({
            pluginId,
            stage: "error",
            progress: 0,
            message: errorInfo.message,
            error: errorInfo.message,
          })
          return {
            success: false,
            error: errorInfo.message,
            errorCategory: errorInfo.category,
            retryable: downloadResult.retryable ?? errorInfo.retryable,
          }
        }
      } else {
        await invoke("plugin_install", {
          source: pluginId,
          installType: "marketplace",
          pluginDir,
        })
      }

      // ADR 0016 P0-3 — Verify signature before promoting the install. The
      // verifier's `config.requireSignatures` is wired to the user-visible
      // Settings → Plugins → Policy toggle via `applyPluginPolicyToRuntime`,
      // so this single call honours whichever stance the user has set.
      // Default is strict-on (signature required); turning the toggle off
      // still runs verification but records a bypass diagnostic so the
      // Audit Panel surfaces the lowered guarantee.
      const pluginPath = `${pluginDir}/${pluginId}`
      const verificationResult = await getPluginSignatureVerifier().verify(pluginPath)
      if (!verificationResult.valid) {
        const reason = verificationResult.reason || "Signature verification failed"
        this.emitProgress({
          pluginId,
          stage: "error",
          progress: 0,
          message: reason,
          error: reason,
        })
        return {
          success: false,
          error: reason,
          errorCategory: "signature_invalid",
          retryable: false,
        }
      }
      if (verificationResult.warnings.length > 0) {
        // Verifier returned `valid: true` but downgraded the result to
        // warning-only — happens when the user has disabled signatureRequired
        // and the bundle is unsigned, or when the signer isn't in the
        // trusted-publishers list. Surface every bypass in the Audit Panel.
        recordSilentFailure(
          pluginId,
          {
            site: "marketplace.signatureBypass",
            message: `Installed without strict signature enforcement: ${verificationResult.warnings.join(", ")}`,
            expected: false,
          },
          new Error(verificationResult.warnings.join(", "))
        )
      }

      const descriptor = buildExtensionDescriptor({
        manifest: plugin.manifest,
        source: "marketplace",
        path: pluginPath,
        pluginDirectory: pluginDir,
        installRootKind: "installed",
      })

      this.emitProgress({
        pluginId,
        stage: "configuring",
        progress: 90,
        message: operation === "update" ? "Finalizing update..." : "Configuring plugin...",
      })

      this.emitProgress({
        pluginId,
        stage: "complete",
        progress: 100,
        message: operation === "update" ? "Update complete!" : "Installation complete!",
      })

      return { success: true, descriptor }
    } catch (error) {
      const normalized = normalizeOperationError(error, "Installation failed")
      this.emitProgress({
        pluginId,
        stage: "error",
        progress: 0,
        message: normalized.message,
        error: normalized.message,
      })
      return {
        success: false,
        error: normalized.message,
        errorCategory: normalized.category,
        retryable: normalized.retryable,
      }
    }
  }

  /**
   * Update plugin using an optional target version.
   */
  async updatePlugin(pluginId: string, version?: string): Promise<PluginInstallResult> {
    return this.installPlugin(pluginId, version, {
      installDependencies: true,
      operation: "update",
    })
  }

  /**
   * Check for updates
   */
  async checkForUpdates(
    installedPlugins: { id: string; version: string }[]
  ): Promise<{ id: string; currentVersion: string; latestVersion: string }[]> {
    const updates: { id: string; currentVersion: string; latestVersion: string }[] = []

    for (const installed of installedPlugins) {
      const plugin = await this.getPlugin(installed.id)
      if (plugin && plugin.latestVersion !== installed.version) {
        updates.push({
          id: installed.id,
          currentVersion: installed.version,
          latestVersion: plugin.latestVersion,
        })
      }
    }

    return updates
  }

  /**
   * Clear the cache
   */
  clearCache() {
    this.cache.clear()
  }

  // =============================================================================
  // Private Helpers
  // =============================================================================

  private getFromCache<T>(key: string): T | null {
    const cached = this.cache.get(key)
    if (!cached) return null

    if (Date.now() - cached.timestamp > this.config.cacheTimeout) {
      this.cache.delete(key)
      return null
    }

    return cached.data as T
  }

  private setCache(key: string, data: unknown) {
    // Evict oldest entries when cache exceeds max size
    if (this.cache.size >= MAX_CACHE_SIZE) {
      const oldestKey = this.cache.keys().next().value
      if (oldestKey) this.cache.delete(oldestKey)
    }
    this.cache.set(key, { data, timestamp: Date.now() })
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let marketplaceInstance: PluginMarketplace | null = null

/**
 * Get the marketplace instance
 */
export function getPluginMarketplace(config?: Partial<MarketplaceConfig>): PluginMarketplace {
  if (!marketplaceInstance) {
    marketplaceInstance = new PluginMarketplace(config)
  }
  return marketplaceInstance
}

/**
 * Reset the marketplace instance
 */
export function resetPluginMarketplace() {
  marketplaceInstance = null
}

// =============================================================================
// React Hook
// =============================================================================

/**
 * Hook to access the marketplace
 */
export function usePluginMarketplace(): PluginMarketplace {
  return getPluginMarketplace()
}
