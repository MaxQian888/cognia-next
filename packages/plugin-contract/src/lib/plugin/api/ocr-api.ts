/**
 * The plugin contract's share of `lib/plugin/api/ocr-api.ts`, which re-exports these.
 */
import type { OcrInput, OcrProvider, OcrResult } from "../../../types/ocr/index"
import type { PluginOcrRegistration } from "../../../types/plugin/plugin-ocr"
import type { SlashOcrResult } from "../../slash-commands/actions/ocr"

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
