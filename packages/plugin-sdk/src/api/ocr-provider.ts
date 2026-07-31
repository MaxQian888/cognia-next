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
