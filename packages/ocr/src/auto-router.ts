/**
 * Auto-router — picks the default OCR provider for the current shell and
 * user settings. Pure (no fetch, no IndexedDB), so it's fully unit-testable
 * with stubbed inputs.
 *
 * Decision order:
 *   1. If `settings.defaultProviderId` is a concrete id and that provider is
 *      both registered and enabled, use it.
 *   2. Otherwise, pick the preferred local engine for the current platform,
 *      provided it's registered, enabled, and (when applicable) reports
 *      itself ready via `localReadiness`.
 *   3. Fall back to the configured cloud provider when the local pick is
 *      missing or unready and `settings.cloudFallbackEnabled` is true and a
 *      cloud provider with credentials exists.
 *   4. As a last resort, return any enabled provider that supports the
 *      current shell.
 *
 * Throws `OcrError("provider_failed", "auto-router", …)` when no provider
 * matches — callers surface that as "configure a provider in settings".
 */

import type { NativePlatform } from "./types/platform"
import { OcrError } from "./errors"
import { type OcrProvider, type UserOcrSettings } from "./types"
import type { OcrRegistry } from "./registry"
import { shellAllows } from "./registry"
import { staticRuntimeStatus, type OcrRuntimeStatusResolver } from "./runtime-status"

/**
 * Optional readiness check for local engines. Some engines (windows-media-ocr
 * with MSIX, ml-kit android plugin) require shell-side detection beyond "are
 * we on the right OS". Auto-router calls this to gate the local-engine pick.
 */
export type LocalReadinessFn = (providerId: string) => boolean | Promise<boolean>

/**
 * Optional credentials check for cloud providers. The fallback layer queries
 * this to skip providers the user hasn't configured yet.
 */
export type HasCredentialsFn = (providerId: string) => boolean | Promise<boolean>

export interface AutoRouterDeps {
  registry: OcrRegistry
  settings: UserOcrSettings
  platform: NativePlatform
  /** Per-platform local engine ordering (head of list = strongest preference). */
  localPreference?: Partial<
    Record<NativePlatform | "windows" | "macos" | "linux" | "ios" | "android" | "browser", string[]>
  >
  /** Sub-OS classification used to drill into the localPreference table. */
  osTag?: "windows" | "macos" | "linux" | "ios" | "android" | "browser"
  /** Legacy local readiness probe; the shared static status is used when omitted. */
  localReadiness?: LocalReadinessFn
  /** Legacy credential probe; the shared static status is used when omitted. */
  hasCredentials?: HasCredentialsFn
  /** Preferred readiness contract. Hosts should provide this instead of the legacy split probes. */
  runtimeStatus?: OcrRuntimeStatusResolver
}

/**
 * Built-in defaults — overridable via `AutoRouterDeps.localPreference`.
 *
 * PaddleOCR is the cross-platform packaged default. Apple Vision remains the
 * first macOS choice. The early-preview, Latin-only `ocrs` backend and the
 * unimplemented Windows.Media.Ocr placeholder stay advanced opt-ins and never
 * enter automatic routing. `local-http` stays out of the preference list — its endpoint
 * is user-configured, so the user picks it explicitly in settings.
 */
export const DEFAULT_LOCAL_PREFERENCE: Required<NonNullable<AutoRouterDeps["localPreference"]>> = {
  tauri: [],
  mobile: [],
  web: ["tesseract-wasm"],
  headless: [],
  windows: ["paddle-ocr", "tesseract-native", "tesseract-wasm"],
  macos: ["apple-vision", "paddle-ocr", "tesseract-native", "tesseract-wasm"],
  linux: ["paddle-ocr", "tesseract-native", "tesseract-wasm"],
  ios: ["apple-vision", "tesseract-wasm"],
  android: ["mlkit-android", "tesseract-wasm"],
  browser: ["tesseract-wasm"],
}

const ADVANCED_ONLY_LOCAL_PROVIDERS = new Set(["ocrs", "windows-media-ocr"])

function isProviderUsable(
  provider: OcrProvider | undefined,
  platform: NativePlatform,
  settings: UserOcrSettings
): provider is OcrProvider {
  if (!provider) return false
  if (!shellAllows(provider, platform)) return false
  if (settings.providerEnabled[provider.id] === false) return false
  return true
}

async function isRuntimeReady(deps: AutoRouterDeps, provider: OcrProvider): Promise<boolean> {
  if (deps.runtimeStatus) return (await deps.runtimeStatus(provider, deps.platform)).ready
  if (provider.category === "local") {
    if (deps.localReadiness) return deps.localReadiness(provider.id)
  } else if (deps.hasCredentials) {
    return deps.hasCredentials(provider.id)
  }
  return staticRuntimeStatus(provider, deps.platform).ready
}

function platformBucket(deps: AutoRouterDeps): readonly string[] {
  const table = { ...DEFAULT_LOCAL_PREFERENCE, ...deps.localPreference }
  if (deps.osTag) {
    return table[deps.osTag] ?? []
  }
  if (deps.platform === "web") return table.browser ?? table.web
  return table[deps.platform] ?? []
}

function allCloudCandidates(deps: AutoRouterDeps): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const push = (id: string) => {
    if (!seen.has(id) && deps.registry.has(id)) {
      seen.add(id)
      out.push(id)
    }
  }
  if (deps.settings.cloudFallbackProviderId) push(deps.settings.cloudFallbackProviderId)
  for (const p of deps.registry.list()) {
    if (p.category !== "local") push(p.id)
  }
  return out
}

/**
 * Resolve to the provider id that should run for this request. Honours an
 * explicit `defaultProviderId` from settings before falling through to
 * platform-local then cloud.
 */
export async function listProviderCandidates(deps: AutoRouterDeps): Promise<OcrProvider[]> {
  const candidates: OcrProvider[] = []
  const seen = new Set<string>()
  const add = async (provider: OcrProvider | undefined, allowAdvancedOnly = false) => {
    if (!provider || seen.has(provider.id)) return
    if (!allowAdvancedOnly && ADVANCED_ONLY_LOCAL_PROVIDERS.has(provider.id)) return
    if (!isProviderUsable(provider, deps.platform, deps.settings)) return
    if (!(await isRuntimeReady(deps, provider))) return
    seen.add(provider.id)
    candidates.push(provider)
  }

  // 1. A saved default is preferred, but an unavailable saved id behaves as auto.
  if (deps.settings.defaultProviderId !== "auto") {
    await add(deps.registry.get(deps.settings.defaultProviderId), true)
  }

  // 2. Platform-local engines, ordered strongest-first.
  for (const id of platformBucket(deps)) {
    const provider = deps.registry.get(id)
    if (provider?.category === "local") await add(provider)
  }

  // 3. Credentialed cloud fallbacks.
  if (deps.settings.cloudFallbackEnabled) {
    for (const id of allCloudCandidates(deps)) {
      const provider = deps.registry.get(id)
      if (provider?.category !== "local") await add(provider)
    }
  }

  // 4. Last resort — still readiness-gated; never route to placeholders.
  for (const p of deps.registry.listForShell(deps.platform)) {
    await add(p)
  }

  return candidates
}

export async function pickDefaultProvider(deps: AutoRouterDeps): Promise<OcrProvider> {
  const [provider] = await listProviderCandidates(deps)
  if (provider) return provider

  throw new OcrError(
    "provider_failed",
    "auto-router",
    "No OCR provider is available for the current shell. Configure one in settings → OCR."
  )
}

/** Synchronous helper for code paths that already know the provider id. */
export function resolveProviderById(
  registry: OcrRegistry,
  id: string,
  platform: NativePlatform
): OcrProvider {
  const provider = registry.get(id)
  if (!provider) {
    throw new OcrError("provider_failed", id, `OCR provider "${id}" is not registered.`)
  }
  if (!shellAllows(provider, platform)) {
    throw new OcrError(
      "unsupported_shell",
      id,
      `OCR provider "${id}" is not available in this shell (${platform}).`
    )
  }
  return provider
}
