/**
 * Android ML Kit Text Recognition OCR provider.
 *
 * Delegates to `@pantrist/capacitor-plugin-ml-kit-text-recognition` (or a
 * thin custom plugin under `mobile/src/plugins/ocr-android/` when the
 * upstream package lacks Capacitor 7 compat). Only available in the
 * Capacitor mobile shell.
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

export interface MlkitAndroidPluginShape {
  recognizeText(input: {
    base64: string
    mimeType: string
    /** "latin" | "chinese" | "devanagari" | "japanese" | "korean" — script hint. */
    script?: string
  }): Promise<{
    text: string
    blocks?: Array<{
      text: string
      bbox?: { x: number; y: number; width: number; height: number }
      confidence?: number
    }>
  }>
}

export interface MlkitAndroidConfig {
  pluginLoader?: () => Promise<MlkitAndroidPluginShape>
  /** BCP-47 -> ML Kit script hint mapping override. */
  scriptFor?: (bcp47: string) => string
}

let pluginLoader: (() => Promise<MlkitAndroidPluginShape>) | null = null

export function __setMlkitAndroidPluginLoader(
  impl: (() => Promise<MlkitAndroidPluginShape>) | null
): void {
  pluginLoader = impl
}

const DEFAULT_PLUGIN_LOADER: () => Promise<MlkitAndroidPluginShape> = async () => {
  const moduleId = "@pantrist/capacitor-plugin-ml-kit-text-recognition"
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod = (await import(/* webpackIgnore: true */ moduleId)) as any
  return (mod.TextRecognition ?? mod.default ?? mod) as MlkitAndroidPluginShape
}

const DEFAULT_SCRIPT_MAP: Record<string, string> = {
  en: "latin",
  fr: "latin",
  de: "latin",
  es: "latin",
  it: "latin",
  pt: "latin",
  zh: "chinese",
  ja: "japanese",
  ko: "korean",
  hi: "devanagari",
  ar: "latin", // ML Kit doesn't have a dedicated Arabic recognizer yet; fall back to Latin.
}

export function defaultScriptFor(bcp47: string): string {
  const lower = bcp47.toLowerCase().split("-")[0]
  return DEFAULT_SCRIPT_MAP[lower] ?? "latin"
}

export function buildMlkitAndroidProvider(): OcrProvider {
  return {
    id: "mlkit-android",
    label: "ML Kit Text Recognition (Android)",
    category: "local",
    shells: { browser: false, tauri: false, capacitor: true },
    credentialKeys: [],
    async extract(input, ctx) {
      return mlkitAndroidExtract(input, ctx)
    },
  }
}

export async function mlkitAndroidExtract(
  input: OcrInput,
  ctx: OcrProviderContext
): Promise<OcrResult> {
  if (ctx.platform !== "mobile") {
    throw new OcrError(
      "unsupported_shell",
      "mlkit-android",
      "ML Kit Text Recognition is only available in the Capacitor mobile shell."
    )
  }
  const config = (ctx.config ?? {}) as MlkitAndroidConfig
  const loader = config.pluginLoader ?? pluginLoader ?? DEFAULT_PLUGIN_LOADER
  const scriptFor = config.scriptFor ?? defaultScriptFor
  const normalized = await normalizeImage(input.source)
  const start = Date.now()
  const firstLang = (input.languages ?? ["en"])[0]!
  const outcome = await withPlugin(loader, async (plugin) =>
    plugin.recognizeText({
      base64: bytesToBase64(normalized.bytes),
      mimeType: normalized.mimeType,
      script: scriptFor(firstLang),
    })
  )
  if ("kind" in outcome) {
    if (outcome.kind === "unsupported") {
      throw new OcrError(
        "unsupported_shell",
        "mlkit-android",
        "ML Kit Text Recognition plugin is not available on this device."
      )
    }
    throw new OcrError("provider_failed", "mlkit-android", outcome.message)
  }
  const blocks: OcrBlock[] = (outcome.blocks ?? []).map((b) => ({
    text: b.text,
    bbox: b.bbox,
    confidence: b.confidence,
    kind: "paragraph",
  }))
  return {
    providerId: "mlkit-android",
    pages: [
      {
        pageNumber: 1,
        markdown: outcome.text,
        text: outcome.text,
        blocks,
      },
    ],
    combinedMarkdown: "",
    combinedText: "",
    languages: input.languages ?? [],
    durationMs: Date.now() - start,
    cached: false,
  }
}

export const mlkitAndroidProvider = buildMlkitAndroidProvider()
