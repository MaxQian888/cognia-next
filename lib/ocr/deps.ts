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

import { detectPlatform } from "@/lib/platform/detect"
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
import { DEFAULT_OCR_SETTINGS, type OcrResult, type UserOcrSettings } from "@/types/ocr"

/** Sub-OS tag consumed by the auto-router's local-engine preference table. */
export type OcrOsTag = "windows" | "macos" | "linux" | "ios" | "android" | "browser"

/**
 * Derive the auto-router OS tag. The browser shell only ever has the WASM
 * engine, so it always reports `"browser"`; Tauri/mobile branch on the
 * user-agent so the router can prefer the matching native engine.
 */
export function detectOcrOsTag(platform: NativePlatform = detectPlatform()): OcrOsTag {
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
}

/** Construct production `ExtractDeps`. Synchronous; per-call async work (settings
 * lookup for main-provider keys, secret reads) happens inside the resolver. */
export function buildOcrDeps(opts: BuildOcrDepsOptions = {}): ExtractDeps {
  const platform = opts.platform ?? detectPlatform()
  return {
    registry: opts.registry ?? getSharedOcrRegistry(),
    settings: opts.settings ?? DEFAULT_OCR_SETTINGS,
    platform,
    osTag: opts.osTag ?? detectOcrOsTag(platform),
    credentialsResolver: opts.credentialsResolver ?? createOcrCredentialsResolver(),
    cache: opts.cache ?? dexieOcrResultCache,
    pageCache: opts.pageCache ?? dexieOcrPageCache,
    attachmentResolver: opts.attachmentResolver,
    filePathResolver: opts.filePathResolver,
    onResult: opts.onResult,
  }
}
