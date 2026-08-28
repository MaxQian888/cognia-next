/**
 * Plugin SDK - `ocr-provider` capability surface.
 *
 * Re-exports the authoring helper, manifest bridge, runtime plugin OCR API,
 * and shared OCR provider registry used by built-ins and plugins.
 */

export { defineOcrProvider } from "../define/define-ocr-provider"

export { createOcrAPI, clearOcrProvidersForPlugin } from "@/lib/plugin/api/ocr-api"

export {
  registerOcrProvidersForPlugin,
  unregisterOcrProvidersForPlugin,
} from "@/lib/plugin/bridge/ocr-providers-bridge"

export {
  createOcrRegistry,
  getSharedOcrRegistry,
  registerOcrProvider,
  shellAllows,
} from "@/lib/ocr/registry"

export type { PluginOcrAPI } from "@/lib/plugin/api/ocr-api"
export type { OcrProvider } from "@/types/ocr"
export type { OcrRegistry } from "@/lib/ocr/registry"
export type {
  PluginOcrProviderDef,
  PluginOcrProviderFactory,
  PluginOcrProviderFactoryContext,
  PluginOcrRegistration,
} from "@/types/plugin/plugin-ocr"

/**
 * The OCR domain vocabulary. An OCR plugin implements `OcrProvider` against
 * these exact shapes — re-exported rather than re-declared so a provider that
 * compiles keeps working when the host's contract moves.
 */
export type {
  OcrBlock,
  OcrBlockKind,
  OcrCostEstimate,
  OcrCredentials,
  OcrInput,
  OcrOutputFormat,
  OcrPage,
  OcrProviderCategory,
  OcrProviderConfig,
  OcrProviderContext,
  OcrProviderShellSupport,
  OcrResult,
  OcrSource,
  UserOcrSettings,
} from "@/types/ocr"

export { DEFAULT_OCR_SETTINGS } from "@/types/ocr"

/**
 * The extraction entry point and its dependency bundle. A plugin that wants
 * the host's full routing (auto-router, PDF splitting, caching, credential
 * resolution) calls `extract()` with deps built by `buildOcrDeps()` instead of
 * hand-rolling a provider call — that is what makes plugin OCR and host OCR
 * produce identical results for the same input.
 */
export { extract } from "@/lib/ocr"
export { buildOcrDeps, createOcrRuntimeStatusResolver, detectOcrOsTag } from "@/lib/ocr/deps"
export type { BuildOcrDepsOptions, OcrOsTag } from "@/lib/ocr/deps"
export type { ExtractDeps } from "@/lib/ocr"

/**
 * Cache seams. `createNullOcrCache()` / `createNullOcrPageCache()` are the
 * no-op implementations a plugin passes when it does not want the host's
 * persisted OCR cache to observe its calls.
 */
export { createNullOcrCache, createNullOcrPageCache } from "@/lib/ocr/cache-contract"
export type {
  CacheLookupKey,
  CacheWriteInput,
  OcrPageCache,
  OcrResultCache,
  PageCacheKey,
} from "@/lib/ocr/cache-contract"

export { OcrError } from "@/lib/ocr/errors"
