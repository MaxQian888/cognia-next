/**
 * `buildOcrDeps()` — the single canonical factory for OCR `ExtractDeps`.
 *
 * Every app surface (composer menu, `/ocr`, agent tool, connectors inbound,
 * twin ingest, automation, workflow node) goes through this so the registry,
 * settings, platform detection, and the real keyring-backed credentials
 * resolver all live in one place. Tests inject overrides; production passes
 * only the loaded `settings`.
 *
 * `attachmentResolver` / `filePathResolver` stay optional pass-throughs: most
 * surfaces already hold a Blob (composer attachment, fetched connector media,
 * captured screenshot) and pass a `blob` / `data-url` source directly, so they
 * don't need a resolver. Callers that genuinely dispatch `attachment-id` /
 * `file-path` sources supply the matching resolver.
 */

import { detectPlatform, isHeadlessHost } from "@/lib/platform/detect"
import type { NativePlatform } from "@/lib/capacitor/_shared"
import { getSharedOcrRegistry } from "./registry"
import { createOcrCredentialsResolver } from "./credentials"
import { dexieOcrPageCache, dexieOcrResultCache } from "./cache"
import type { OcrPageCache, OcrResultCache } from "./cache-contract"
import type {
  AttachmentResolver,
  CredentialsResolver,
  ExtractDeps,
  FilePathResolver,
} from "./index"
import type { OcrRegistry } from "./registry"
import { shellAllows } from "./registry"
import { DEFAULT_OCR_SETTINGS, type OcrResult, type UserOcrSettings } from "@/types/ocr"
import type { OcrProvider } from "@/types/ocr"
import type { OcrRuntimeStatus, OcrRuntimeStatusResolver } from "@cognia/ocr/runtime-status"

/** Sub-OS tag consumed by the auto-router's local-engine preference table. */
export type OcrOsTag = "windows" | "macos" | "linux" | "ios" | "android" | "browser"

/**
 * Derive the auto-router OS tag. The browser shell only ever has the WASM
 * engine, so it always reports `"browser"`; Tauri/mobile branch on the
 * user-agent so the router can prefer the matching native engine.
 */
export function detectOcrOsTag(platform: NativePlatform = detectPlatform()): OcrOsTag {
  if (platform === "headless") {
    const nodePlatform = (globalThis as typeof globalThis & { process?: { platform?: string } })
      .process?.platform
    if (nodePlatform === "win32") return "windows"
    if (nodePlatform === "darwin") return "macos"
    return "linux"
  }
  const ua = (typeof navigator !== "undefined" ? navigator.userAgent : "").toLowerCase()
  if (platform === "mobile") {
    return /iphone|ipad|ipod/.test(ua) ? "ios" : "android"
  }
  if (platform === "web") return "browser"
  // Tauri desktop — read the host OS off the webview UA.
  if (/windows|win32|win64/.test(ua)) return "windows"
  if (/macintosh|mac os x/.test(ua)) return "macos"
  if (/linux|x11/.test(ua)) return "linux"
  return "browser"
}

export interface BuildOcrDepsOptions {
  /** Loaded user settings. Defaults to `DEFAULT_OCR_SETTINGS` when omitted. */
  settings?: UserOcrSettings
  /** Override the shared registry (tests). */
  registry?: OcrRegistry
  /** Override the detected shell (tests). */
  platform?: NativePlatform
  /** Override the detected OS tag (tests). */
  osTag?: OcrOsTag
  /** Override the credentials resolver (tests). */
  credentialsResolver?: CredentialsResolver
  /** Override the result cache (tests, or callers that must not persist). */
  cache?: OcrResultCache
  /** Override the per-page cache used by the streaming PDF path. */
  pageCache?: OcrPageCache
  /** Resolver for `attachment-id` sources (connectors, agent tool). */
  attachmentResolver?: AttachmentResolver
  /** Resolver for `file-path` sources. */
  filePathResolver?: FilePathResolver
  /** Observability hook — every extract result flows through here. */
  onResult?: (result: OcrResult) => void
  /** Override runtime readiness (tests/alternate shells). */
  runtimeStatus?: OcrRuntimeStatusResolver
}

/** Construct production `ExtractDeps`. Synchronous; per-call async work (settings
 * lookup for main-provider keys, secret reads) happens inside the resolver. */
export function buildOcrDeps(opts: BuildOcrDepsOptions = {}): ExtractDeps {
  const platform = opts.platform ?? detectPlatform()
  const settings = opts.settings ?? DEFAULT_OCR_SETTINGS
  const credentialsResolver = opts.credentialsResolver ?? createOcrCredentialsResolver()
  return {
    registry: opts.registry ?? getSharedOcrRegistry(),
    settings,
    platform,
    osTag: opts.osTag ?? detectOcrOsTag(platform),
    credentialsResolver,
    runtimeStatus:
      opts.runtimeStatus ?? createOcrRuntimeStatusResolver(settings, credentialsResolver),
    cache: opts.cache ?? dexieOcrResultCache,
    pageCache: opts.pageCache ?? dexieOcrPageCache,
    attachmentResolver: opts.attachmentResolver,
    filePathResolver: opts.filePathResolver,
    onResult: opts.onResult,
  }
}

const OPTIONAL_CREDENTIAL_KEYS = new Set(["sessionToken"])
const MAIN_PROVIDER_IDS: Record<string, readonly string[]> = {
  "anthropic-vision": ["anthropic"],
  "openai-vision": ["openai"],
  "gemini-vision": ["gemini", "google"],
}

interface NativeModelStatus {
  installed?: boolean
  variant?: string
  version?: string
  integrity?: "verified" | "missing" | "corrupt" | "unknown"
  reason?: string
}

/** Production implementation of the shared runtime truth contract. */
export function createOcrRuntimeStatusResolver(
  settings: UserOcrSettings,
  credentialsResolver: CredentialsResolver
): OcrRuntimeStatusResolver {
  let availableBackends: Promise<Set<string>> | null = null
  const loadAvailableBackends = () =>
    (availableBackends ??= invokeOcrCommand<string[]>("ocr_list_available_backends").then(
      (ids) => new Set(ids),
      () => new Set()
    ))

  return async (provider, platform) => {
    if (!shellAllows(provider, platform)) {
      return unavailable(provider, "unsupported-shell")
    }
    if (provider.category !== "local") {
      const configured = await hasProviderCredentials(provider, credentialsResolver)
      return {
        providerId: provider.id,
        shellSupported: true,
        credentialsConfigured: configured,
        ready: configured,
        reason: configured ? undefined : "missing-credentials",
      }
    }
    if (provider.id === "local-http") {
      const endpoint = settings.providerConfig[provider.id]?.endpoint
      const configured = typeof endpoint === "string" && endpoint.trim().length > 0
      return {
        providerId: provider.id,
        shellSupported: true,
        ready: configured,
        reason: configured ? undefined : "configuration-required",
      }
    }
    if (provider.id === "tesseract-wasm") {
      return { providerId: provider.id, shellSupported: true, ready: true }
    }
    if (platform !== "tauri" && platform !== "headless") {
      return unavailable(provider, "backend-not-bound")
    }

    const backends = await loadAvailableBackends()
    const backendBound = backends.has(provider.id)
    if (!backendBound) {
      return {
        ...unavailable(provider, "backend-not-bound"),
        backendBound: false,
      }
    }
    if (provider.id !== "paddle-ocr" && provider.id !== "ocrs") {
      return { providerId: provider.id, shellSupported: true, backendBound: true, ready: true }
    }

    const model: NativeModelStatus = await invokeOcrCommand<NativeModelStatus>("ocr_model_status", {
      backend: provider.id,
      variant: settings.providerConfig[provider.id]?.model,
    }).catch(() => ({ installed: false, integrity: "unknown" as const }))
    const integrity = model.integrity ?? (model.installed ? "unknown" : "missing")
    const ready = !!model.installed && integrity === "verified"
    return {
      providerId: provider.id,
      shellSupported: true,
      backendBound: true,
      model: {
        variant: model.variant,
        version: model.version,
        installed: !!model.installed,
        integrity,
      },
      ready,
      reason: ready ? undefined : integrity === "corrupt" ? "model-corrupt" : "model-missing",
      detail: model.reason,
    }
  }
}

async function hasProviderCredentials(
  provider: OcrProvider,
  resolver: CredentialsResolver
): Promise<boolean> {
  const credentials = await resolver(provider.id, provider.credentialKeys)
  if (provider.reusesMainProviderKey) {
    for (const id of MAIN_PROVIDER_IDS[provider.id] ?? []) {
      if (await credentials.getMainProviderKey?.(id)) return true
    }
    return false
  }
  return provider.credentialKeys
    .filter((key) => !OPTIONAL_CREDENTIAL_KEYS.has(key))
    .every((key) => !!credentials.secrets[key]?.trim())
}

function unavailable(
  provider: OcrProvider,
  reason: NonNullable<OcrRuntimeStatus["reason"]>
): OcrRuntimeStatus {
  return {
    providerId: provider.id,
    shellSupported: reason !== "unsupported-shell",
    ready: false,
    reason,
  }
}

async function invokeOcrCommand<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (isHeadlessHost()) {
    const { transport } = await import("@/lib/tauri")
    return transport.call<T>(command, args)
  }
  const { invoke } = await import("@tauri-apps/api/core")
  return invoke<T>(command, args)
}
