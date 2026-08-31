/**
 * Plugin OCR Provider API.
 *
 * Lets a plugin contribute a custom `OcrProvider` to the shared OCR
 * registry (`lib/ocr/registry.ts:registerOcrProvider`). Plugins call
 * `ctx.ocr.registerProvider(provider)` from `activate()`, or declare
 * `manifest.ocrProviders[]` and let `lib/plugin/bridge/ocr-providers-bridge.ts`
 * register on enable.
 *
 * The registration handle is auto-revoked when the plugin is disabled
 * (`clearOcrProvidersForPlugin(pluginId)`), so manual cleanup is
 * belt-and-braces.
 *
 * Provider ids are namespaced as `<pluginId>:<providerId>` to prevent
 * collisions with built-ins and across plugins. The registry's internal
 * duplicate check fires if the same plugin tries to register twice.
 *
 * See ADR-0026 §2 §A.
 */

import { createPluginSystemLogger } from "../core/logger"
import { createGuardedAPI } from "@/lib/plugin/security/permission-guard"
import { registerOcrProvider, getSharedOcrRegistry } from "@/lib/ocr/registry"
import type { OcrProvider } from "@/types/ocr"
import type { OcrInput, OcrResult } from "@/types/ocr"
import type { PluginOcrRegistration } from "@/types/plugin/plugin-ocr"
import { extract } from "@/lib/ocr"
import { buildOcrDeps } from "@/lib/ocr/deps"
import { loadUserOcrSettings } from "@/lib/ocr/user-settings"
import { ocrScreen } from "@/lib/automation/ocr-screen"
import { handleOcrSlashCommand, type SlashOcrResult } from "@/lib/slash-commands/actions/ocr"
import { detectPlatform } from "@/lib/platform/detect"

// Track which provider ids each plugin has registered so we can drop them
// all on plugin disable without leaning on the registry's plugin-aware
// helpers (which don't exist — the OCR registry predates plugin lifecycle).
const ownedByPlugin = new Map<string, Set<string>>()

export interface PluginOcrAPI {
  /**
   * Register a custom OCR provider. The given `providerId` is prefixed with
   * the plugin id before reaching the underlying registry. Returns a handle
   * with an `unregister()` method (idempotent — the host also auto-cleans
   * on plugin disable).
   *
   * Throws if the plugin has already registered a provider with the same
   * unprefixed id.
   */
  registerProvider(provider: OcrProvider): PluginOcrRegistration
  /** Snapshot of provider ids this plugin has registered. */
  listRegistered(): string[]
  /** Every provider currently available to the shared host router. */
  listAvailableProviders(): string[]
  /** Whether at least one provider is available for extraction. */
  isReady(): boolean
  /** Extract from a blob or data URL through the host's settings, credentials, and caches. */
  extract(input: OcrInput): Promise<OcrResult>
  /** Desktop file-path extraction with a host-owned filesystem resolver. */
  extractFile(path: string, options?: Omit<OcrInput, "source">): Promise<OcrResult>
  /** Capture the screen and OCR it through the native automation path. */
  extractScreen(options?: { languages?: string[] }): Promise<OcrResult>
  /** Execute the canonical `/ocr` parser and result projection. */
  runSlashCommand(argv: string): Promise<SlashOcrResult>
}

interface PluginOcrRuntime {
  listAvailableProviders(): string[]
  extract(input: OcrInput): Promise<OcrResult>
  extractFile(path: string, options?: Omit<OcrInput, "source">): Promise<OcrResult>
  extractScreen(options?: { languages?: string[] }): Promise<OcrResult>
  runSlashCommand(argv: string): Promise<SlashOcrResult>
}

/**
 * The extraction half of this API reaches real host resources —
 * `extractFile` reads an arbitrary path through the Tauri filesystem plugin
 * and `extractScreen` captures the desktop — so it goes through
 * `createGuardedAPI`. The contract catalog declares the same permissions, but
 * its `ocr` namespace is `enforcement: "shadow"` (audit-only), so the guard is
 * what actually enforces them.
 *
 * `registerProvider` / `listRegistered` / `listAvailableProviders` / `isReady`
 * stay unguarded: they only read or mutate this plugin's own slice of the
 * provider registry and touch no user data.
 */
export function createOcrAPI(
  pluginId: string,
  runtime: PluginOcrRuntime = defaultOcrRuntime
): PluginOcrAPI {
  const logger = createPluginSystemLogger(pluginId)
  const api: PluginOcrAPI = {
    registerProvider(provider) {
      const prefixed = `${pluginId}:${provider.id}`
      const owned = ownedByPlugin.get(pluginId) ?? new Set<string>()
      if (owned.has(prefixed)) {
        throw new Error(
          `[ocr-api] plugin ${pluginId} already registered an OCR provider with id "${provider.id}"`
        )
      }
      const wrapped: OcrProvider = { ...provider, id: prefixed }
      registerOcrProvider(wrapped)
      owned.add(prefixed)
      ownedByPlugin.set(pluginId, owned)
      logger.info(`[ocr] registered provider "${prefixed}"`)
      return {
        providerId: prefixed,
        unregister: () => {
          if (!owned.has(prefixed)) return
          // The registry has `unregister(id)` returning a boolean.
          getSharedOcrRegistry().unregister(prefixed)
          owned.delete(prefixed)
          if (owned.size === 0) ownedByPlugin.delete(pluginId)
          logger.info(`[ocr] unregistered provider "${prefixed}"`)
        },
      }
    },
    listRegistered() {
      return Array.from(ownedByPlugin.get(pluginId) ?? [])
    },
    listAvailableProviders: runtime.listAvailableProviders,
    isReady: () => runtime.listAvailableProviders().length > 0,
    extract: runtime.extract,
    extractFile: runtime.extractFile,
    extractScreen: runtime.extractScreen,
    runSlashCommand: runtime.runSlashCommand,
  }

  return createGuardedAPI(
    pluginId,
    api,
    {
      extract: ["media:image:read", "database:write"],
      extractFile: ["native:filesystem", "media:image:read", "database:write"],
      extractScreen: [
        "automation:screenshot",
        "native:screen",
        "media:image:read",
        "database:write",
      ],
      runSlashCommand: ["native:filesystem", "media:image:read", "database:write"],
    },
    {
      unguarded: ["registerProvider", "listRegistered", "listAvailableProviders", "isReady"],
    }
  )
}

async function hostDeps() {
  const settings = await loadUserOcrSettings()
  return buildOcrDeps({ settings })
}

async function resolveFilePath(path: string): Promise<{
  blob: Blob
  mimeType: string
  bytes: Uint8Array
}> {
  if (detectPlatform() !== "tauri") {
    throw new Error("file-path OCR requires the desktop app")
  }
  const { readFile } = await import("@tauri-apps/plugin-fs")
  const bytes = await readFile(path)
  const mimeType = mimeFromPath(path)
  return { blob: new Blob([bytes as BlobPart], { type: mimeType }), mimeType, bytes }
}

const EXTENSION_MIME: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  heic: "image/heic",
  pdf: "application/pdf",
}

function mimeFromPath(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase() ?? ""
  return EXTENSION_MIME[extension] ?? "application/octet-stream"
}

const defaultOcrRuntime: PluginOcrRuntime = {
  listAvailableProviders: () =>
    getSharedOcrRegistry()
      .list()
      .map((provider) => provider.id),
  extract: async (input) => extract(input, await hostDeps()),
  extractFile: async (path, options = {}) =>
    extract(
      { ...options, source: { kind: "file-path", path } },
      { ...(await hostDeps()), filePathResolver: resolveFilePath }
    ),
  extractScreen: (options) => ocrScreen(options),
  runSlashCommand: async (argv) =>
    handleOcrSlashCommand({
      argv,
      deps: { ...(await hostDeps()), filePathResolver: resolveFilePath },
    }),
}

/**
 * Plugin-disable hook — drop every OCR provider the plugin owns. Called by
 * the plugin manager when disabling/unloading; safe to call multiple times.
 */
export function clearOcrProvidersForPlugin(pluginId: string): void {
  const owned = ownedByPlugin.get(pluginId)
  if (!owned) return
  for (const id of owned) {
    getSharedOcrRegistry().unregister(id)
  }
  ownedByPlugin.delete(pluginId)
}

/** Test-only. */
export function __resetOcrApiForTesting(): void {
  ownedByPlugin.clear()
}
