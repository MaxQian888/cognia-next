/**
 * Android ML Kit Text Recognition OCR provider.
 *
 * Delegates to `@pantrist/capacitor-plugin-ml-kit-text-recognition` (v8):
 * the plugin exports `TextRecognition` with a single method
 * `detectText({ base64Image, rotation? })` returning `{ text, blocks }`
 * where each block carries `text`, a `boundingBox` (left/top/right/bottom)
 * and a `recognizedLanguage`. ML Kit auto-detects the script — the plugin
 * takes no language or script parameters. Only available in the Capacitor
 * mobile shell, and only when the native plugin is bundled into the
 * mobile app.
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

/** npm package that ships the Capacitor ML Kit text-recognition plugin. */
export const MLKIT_PLUGIN_PACKAGE = "@pantrist/capacitor-plugin-ml-kit-text-recognition"

/** Block shape returned by the upstream plugin (`Block extends TextBase`). */
export interface MlKitTextBlock {
  text: string
  boundingBox?: { left: number; top: number; right: number; bottom: number } | null
  recognizedLanguage?: string
}

/**
 * Upstream plugin surface — mirrors `TextRecognitionPlugin` from
 * `@pantrist/capacitor-plugin-ml-kit-text-recognition/src/definitions.ts`.
 */
export interface MlKitTextRecognitionPluginShape {
  detectText(options: { base64Image: string; rotation?: number }): Promise<{
    text: string
    blocks?: MlKitTextBlock[]
  }>
}

export interface MlkitAndroidConfig {
  pluginLoader?: () => Promise<MlKitTextRecognitionPluginShape>
}

let pluginLoader: (() => Promise<MlKitTextRecognitionPluginShape>) | null = null

export function __setMlkitAndroidPluginLoader(
  impl: (() => Promise<MlKitTextRecognitionPluginShape>) | null
): void {
  pluginLoader = impl
}

/**
 * Default loader — dynamic-imports the upstream package and returns its
 * `TextRecognition` export. The module spec is dynamic so TS/webpack don't
 * try to resolve the (optional, native-only) package during web/desktop
 * builds. When the package isn't bundled the import rejects and `withPlugin`
 * collapses to `{ kind: "unsupported" }`, which the providers surface as
 * `unsupported_shell` naming the missing package.
 */
export const loadMlKitTextRecognitionPlugin: () => Promise<MlKitTextRecognitionPluginShape> =
  async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = (await import(/* webpackIgnore: true */ MLKIT_PLUGIN_PACKAGE)) as any
    const plugin = mod?.TextRecognition
    if (!plugin) {
      throw new Error(`${MLKIT_PLUGIN_PACKAGE} did not export TextRecognition`)
    }
    return plugin as MlKitTextRecognitionPluginShape
  }

/** Map the plugin's left/top/right/bottom box to the x/y/width/height bbox. */
export function mapMlKitBlock(block: MlKitTextBlock): OcrBlock {
  const box = block.boundingBox
  return {
    text: block.text,
    bbox: box
      ? { x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top }
      : undefined,
    kind: "paragraph",
  }
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
  const loader = config.pluginLoader ?? pluginLoader ?? loadMlKitTextRecognitionPlugin
  const normalized = await normalizeImage(input.source)
  const start = Date.now()
  const outcome = await withPlugin(loader, async (plugin) =>
    plugin.detectText({ base64Image: bytesToBase64(normalized.bytes) })
  )
  if ("kind" in outcome) {
    if (outcome.kind === "unsupported") {
      throw new OcrError(
        "unsupported_shell",
        "mlkit-android",
        `ML Kit Text Recognition requires the ${MLKIT_PLUGIN_PACKAGE} Capacitor plugin, which is not included in this build.`
      )
    }
    throw new OcrError("provider_failed", "mlkit-android", outcome.message)
  }
  const blocks: OcrBlock[] = (outcome.blocks ?? []).map(mapMlKitBlock)
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
