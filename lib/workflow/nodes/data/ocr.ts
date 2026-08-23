/**
 * OCR workflow node executor (`ocr.extract`, ADR-0024).
 *
 * Runs an image / PDF through the shared OCR `extract()` pipeline so workflows
 * can turn an upstream screenshot, a URL, or inline bytes into text. Output is
 * the same per-document shape other data nodes consume:
 *   { text, markdown, pages, providerId, durationMs, cached }
 *
 * Source resolution (first match wins):
 *   - `dataUrl`            — a `data:<mime>;base64,…` URL
 *   - `imageBase64` (+ `mimeType`, default png) — raw base64 from an upstream
 *     screenshot node's `bytes`
 *   - `url`               — fetched in the renderer and OCR'd as a blob
 *   - `screen: true`      — capture the desktop and OCR it (gated by the
 *     automation permission layer)
 */

import { extract } from "@/lib/ocr"
import { buildOcrDeps } from "@/lib/ocr/deps"
import { registerNodeExecutor } from "../registry"
import { proxyFetch } from "@/lib/network/proxy-fetch"
import type { StepExecutionContext } from "@/types/workflow/visual"
import type { OcrInput, OcrOutputFormat, OcrResult } from "@/types/ocr"

function strParam(params: Record<string, unknown>, key: string): string | undefined {
  const v = params[key]
  return typeof v === "string" && v.length > 0 ? v : undefined
}

function languagesParam(params: Record<string, unknown>): string[] | undefined {
  const v = params.languages
  if (!Array.isArray(v)) return undefined
  const langs = v.filter((x): x is string => typeof x === "string" && x.length > 0)
  return langs.length > 0 ? langs : undefined
}

function mimeFromDataUrl(dataUrl: string): string {
  const m = /^data:([^;,]+)/.exec(dataUrl)
  return m ? m[1]! : "application/octet-stream"
}

/** Resolve the node's image source into an `OcrInput.source`. */
export async function resolveOcrNodeSource(
  params: Record<string, unknown>
): Promise<OcrInput["source"]> {
  const dataUrl = strParam(params, "dataUrl")
  if (dataUrl) return { kind: "data-url", dataUrl, mimeType: mimeFromDataUrl(dataUrl) }

  const imageBase64 = strParam(params, "imageBase64")
  if (imageBase64) {
    const mimeType = strParam(params, "mimeType") ?? "image/png"
    return { kind: "data-url", dataUrl: `data:${mimeType};base64,${imageBase64}`, mimeType }
  }

  const url = strParam(params, "url")
  if (url) {
    // `proxyFetch`, like every other workflow egress: the image lives on
    // whatever host the author pointed at, which `connect-src` does not list.
    const blob = await (await proxyFetch(url)).blob()
    return { kind: "blob", blob, mimeType: blob.type || "application/octet-stream" }
  }

  throw new Error("ocr.extract: no image source (set dataUrl, imageBase64, url, or screen)")
}

registerNodeExecutor({
  kind: "ocr.extract",
  typeVersion: 1,
  execute: async (ctx: StepExecutionContext) => {
    const params = ctx.params
    const languages = languagesParam(params)
    const provider = strParam(params, "provider")
    const format = strParam(params, "format") as OcrOutputFormat | undefined
    const pageRange = strParam(params, "pageRange")

    let result: OcrResult
    if (params.screen === true) {
      const { ocrScreen } = await import("@/lib/automation/ocr-screen")
      result = await ocrScreen({ languages })
    } else {
      const source = await resolveOcrNodeSource(params)
      result = await extract(
        {
          source,
          languages,
          format,
          pageRange,
          providerId: provider && provider !== "auto" ? provider : undefined,
        },
        buildOcrDeps()
      )
    }

    return {
      output: {
        text: result.combinedText,
        markdown: result.combinedMarkdown,
        pages: result.pages,
        providerId: result.providerId,
        durationMs: result.durationMs,
        cached: result.cached,
      },
    }
  },
})
