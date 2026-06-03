/**
 * Apple Vision OCR provider.
 *
 * Two run paths share this file:
 *   - **Tauri (macOS)** — delegates to the Swift sidecar at
 *     `src-tauri/sidecars/apple-vision-ocr/` via the shared
 *     `NativeOcrInvoker`.
 *   - **Capacitor (iOS)** — calls the `@pantrist/capacitor-plugin-ml-kit-text-
 *     recognition` plugin via `withPlugin()` from `lib/capacitor/_shared.ts`.
 *
 * The provider switches on `ctx.platform`; both branches share the same
 * `OcrResult` shape.
 */

import { withPlugin } from "@/lib/capacitor/_shared"
import { OcrError } from "@/lib/ocr/errors"
import { bytesToBase64, normalizeImage } from "../image-prep"
import {
  type OcrBlock,
  type OcrInput,
  type OcrProvider,
  type OcrProviderContext,
  type OcrResult,
} from "@/types/ocr"
import type { NativeOcrInvoker, NativeOcrResult } from "./tesseract-native"

export interface AppleVisionPluginShape {
  recognizeText(input: {
    base64: string
    mimeType: string
    languages?: string[]
    automaticLanguageDetection?: boolean
  }): Promise<{
    text: string
    blocks?: Array<{
      text: string
      bbox?: { x: number; y: number; width: number; height: number }
      confidence?: number
    }>
  }>
}

export interface AppleVisionConfig {
  /** Tauri invoker — used on macOS via Swift sidecar. */
  invoker?: NativeOcrInvoker
  /** Capacitor plugin loader — used on iOS. */
  pluginLoader?: () => Promise<AppleVisionPluginShape>
}

let tauriInvoker: NativeOcrInvoker | null = null
let mobileLoader: (() => Promise<AppleVisionPluginShape>) | null = null

/** App-boot hook for the Tauri side. */
export function __setAppleVisionTauriInvoker(impl: NativeOcrInvoker | null): void {
  tauriInvoker = impl
}

/** App-boot hook for the Capacitor side. */
export function __setAppleVisionPluginLoader(
  loader: (() => Promise<AppleVisionPluginShape>) | null
): void {
  mobileLoader = loader
}

const DEFAULT_PLUGIN_LOADER: () => Promise<AppleVisionPluginShape> = async () => {
  // The plugin is an optional native dep — its module spec is dynamic so TS
  // (and webpack/turbopack) don't try to resolve it during web/desktop builds.
  const moduleId = "@pantrist/capacitor-plugin-ml-kit-text-recognition"
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod = (await import(/* webpackIgnore: true */ moduleId)) as any
  return (mod.TextRecognition ?? mod.default ?? mod) as AppleVisionPluginShape
}

export function buildAppleVisionProvider(): OcrProvider {
  return {
    id: "apple-vision",
    label: "Apple Vision",
    category: "local",
    shells: { browser: false, tauri: true, capacitor: true },
    credentialKeys: [],
    async extract(input, ctx) {
      return appleVisionExtract(input, ctx)
    },
  }
}

export async function appleVisionExtract(
  input: OcrInput,
  ctx: OcrProviderContext
): Promise<OcrResult> {
  const config = (ctx.config ?? {}) as AppleVisionConfig
  const normalized = await normalizeImage(input.source)
  const languages = (input.languages ?? ["en"]).map((l) => l.toLowerCase())
  const start = Date.now()

  if (ctx.platform === "tauri") {
    const invoker = config.invoker ?? tauriInvoker
    if (!invoker) {
      throw new OcrError(
        "unsupported_shell",
        "apple-vision",
        "Apple Vision sidecar invoker is not registered."
      )
    }
    let payload: NativeOcrResult
    try {
      payload = await invoker({
        backend: "apple-vision",
        bytes: normalized.bytes,
        mimeType: normalized.mimeType,
        languages,
      })
    } catch (err) {
      throw new OcrError(
        "provider_failed",
        "apple-vision",
        err instanceof Error ? err.message : String(err),
        err
      )
    }
    return buildResult(
      payload.text,
      payload.blocks ?? [],
      payload.width,
      payload.height,
      input,
      start
    )
  }

  if (ctx.platform === "mobile") {
    const loader = config.pluginLoader ?? mobileLoader ?? DEFAULT_PLUGIN_LOADER
    const outcome = await withPlugin(loader, async (plugin) =>
      plugin.recognizeText({
        base64: bytesToBase64(normalized.bytes),
        mimeType: normalized.mimeType,
        languages,
      })
    )
    if ("kind" in outcome) {
      if (outcome.kind === "unsupported") {
        throw new OcrError(
          "unsupported_shell",
          "apple-vision",
          "Apple Vision plugin is not available on this device."
        )
      }
      throw new OcrError("provider_failed", "apple-vision", outcome.message)
    }
    return buildResult(
      outcome.text,
      (outcome.blocks ?? []).map((b) => ({
        text: b.text,
        bbox: b.bbox,
        confidence: b.confidence,
      })),
      undefined,
      undefined,
      input,
      start
    )
  }

  throw new OcrError(
    "unsupported_shell",
    "apple-vision",
    "Apple Vision is only available in Tauri (macOS) and Capacitor (iOS)."
  )
}

function buildResult(
  text: string,
  blocks: Array<{ text: string; bbox?: OcrBlock["bbox"]; confidence?: number }>,
  width: number | undefined,
  height: number | undefined,
  input: OcrInput,
  start: number
): OcrResult {
  return {
    providerId: "apple-vision",
    pages: [
      {
        pageNumber: 1,
        markdown: text,
        text,
        blocks: blocks.map((b) => ({
          text: b.text,
          bbox: b.bbox,
          confidence: b.confidence,
          kind: "paragraph" as const,
        })),
        width,
        height,
      },
    ],
    combinedMarkdown: "",
    combinedText: "",
    languages: input.languages ?? [],
    durationMs: Date.now() - start,
    cached: false,
  }
}

export const appleVisionProvider = buildAppleVisionProvider()
