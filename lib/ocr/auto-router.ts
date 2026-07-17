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

import type { NativePlatform } from "@/lib/capacitor/_shared"
import { OcrError } from "@/lib/ocr/errors"
import { type OcrProvider, type UserOcrSettings } from "@/types/ocr"
import type { OcrRegistry } from "./registry"
import { shellAllows } from "./registry"

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
  /** Defaults to `() => true` — no readiness gate. */
  localReadiness?: LocalReadinessFn
  /** Defaults to `() => true` — no credentials gate. */
  hasCredentials?: HasCredentialsFn
}

/**
 * Built-in defaults — overridable via `AutoRouterDeps.localPreference`.
 *
 * `ocrs` and `paddle-ocr` are pure-Rust local engines wired through the
 * `ocr-ocrs` / `ocr-paddle` Cargo features. They sit just behind the
 * platform-native engines (Windows.Media.Ocr, Apple Vision) and ahead of
 * Tesseract because they require no system toolchain and emit per-line
 * bboxes. `local-http` stays out of the preference list — its endpoint
 * is user-configured, so the user picks it explicitly in settings.
 */
export const DEFAULT_LOCAL_PREFERENCE: Required<NonNullable<AutoRouterDeps["localPreference"]>> = {
  tauri: [],
  mobile: [],
  web: ["tesseract-wasm"],
  headless: [],
  windows: ["windows-media-ocr", "ocrs", "paddle-ocr", "tesseract-native", "tesseract-wasm"],
  macos: ["apple-vision", "ocrs", "paddle-ocr", "tesseract-native", "tesseract-wasm"],
  linux: ["ocrs", "paddle-ocr", "tesseract-native", "tesseract-wasm"],
  ios: ["apple-vision", "tesseract-wasm"],
  android: ["mlkit-android", "tesseract-wasm"],
  browser: ["tesseract-wasm"],
}

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

async function firstReadyLocal(
  deps: AutoRouterDeps,
  candidates: readonly string[]
): Promise<OcrProvider | null> {
  const readyCheck = deps.localReadiness ?? (() => true)
  for (const id of candidates) {
    const provider = deps.registry.get(id)
    if (!isProviderUsable(provider, deps.platform, deps.settings)) continue
    if (provider.category !== "local") continue
    const ready = await readyCheck(id)
    if (ready) return provider
  }
  return null
}

async function firstCloudWithCreds(
  deps: AutoRouterDeps,
  candidates: readonly string[]
): Promise<OcrProvider | null> {
  const credCheck = deps.hasCredentials ?? (() => true)
  for (const id of candidates) {
    const provider = deps.registry.get(id)
    if (!isProviderUsable(provider, deps.platform, deps.settings)) continue
    const ok = await credCheck(id)
    if (ok) return provider
  }
  return null
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
export async function pickDefaultProvider(deps: AutoRouterDeps): Promise<OcrProvider> {
  // 1. Explicit setting wins — if the user pinned a provider, use it.
  if (deps.settings.defaultProviderId !== "auto") {
    const pinned = deps.registry.get(deps.settings.defaultProviderId)
    if (isProviderUsable(pinned, deps.platform, deps.settings)) {
      return pinned
    }
  }

  // 2. Platform-local engine.
  const localPick = await firstReadyLocal(deps, platformBucket(deps))
  if (localPick) return localPick

  // 3. Cloud fallback.
  if (deps.settings.cloudFallbackEnabled) {
    const cloudPick = await firstCloudWithCreds(deps, allCloudCandidates(deps))
    if (cloudPick) return cloudPick
  }

  // 4. Last resort — any registered, shell-compatible, enabled provider.
  for (const p of deps.registry.listForShell(deps.platform)) {
    if (deps.settings.providerEnabled[p.id] === false) continue
    return p
  }

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
