/**
 * Screenshot — built-in plugin.
 *
 * Wires the host-provided `captureScreenshot()` helper into:
 *   * an agent tool `take_screenshot` that returns the PNG as an MCP image
 *     content block (so vision models see it and the chat renders it)
 *   * a slash command `/screenshot` that triggers the same capture from chat
 *
 * Both paths share the same capture function; on success they also write the
 * PNG to the clipboard (when the runtime allows). Failures are returned as
 * `{ ok: false, error }` rather than thrown so the manager records them as
 * tool diagnostics rather than fatal exceptions.
 */

import { ScreenshotResultCard } from "./screenshot-result-card"
import type { PluginContext, PluginDefinition, PluginManifest } from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"
import { captureScreenshot } from "@cognia/plugin-sdk/api/automation"
import { buildOcrDeps, extract } from "@cognia/plugin-sdk/api/ocr-provider"
async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  let binary = ""
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i] as number)
  }
  // btoa is safe here because we limit to PNG bytes.
  return typeof btoa === "function"
    ? btoa(binary)
    : Buffer.from(binary, "binary").toString("base64")
}

async function copyToClipboard(file: File): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.clipboard?.write) {
    return false
  }
  try {
    const item = new ClipboardItem({ [file.type]: file })
    await navigator.clipboard.write([item])
    return true
  } catch {
    return false
  }
}

interface CaptureResult {
  ok: boolean
  filename?: string
  size?: number
  base64?: string
  mimeType?: string
  copiedToClipboard?: boolean
  error?: string
}

async function performCapture(): Promise<CaptureResult> {
  try {
    const file = await captureScreenshot()
    if (!file) {
      return { ok: false, error: "user-cancelled-or-unsupported" }
    }
    const base64 = await fileToBase64(file)
    const copied = await copyToClipboard(file)
    return {
      ok: true,
      filename: file.name,
      size: file.size,
      base64,
      mimeType: file.type || "image/png",
      copiedToClipboard: copied,
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Shape the capture as an MCP `CallToolResult` so the PNG travels as a real
 * image content block.
 *
 * Returning `{ ok, base64 }` — as this tool used to — meant the sidecar
 * `JSON.stringify`-ed it into one text block: the model received a few thousand
 * tokens of base64 it cannot decode, and the chat rendered the same wall. The
 * block form is what `sidecar/builtin-tools/safety.mjs:toolImage` produces for
 * built-in tools, and both dispatch paths now pass it through untouched, so a
 * vision-capable model actually sees the screen.
 *
 * The failure envelope stays a plain object: the passthrough only triggers on a
 * well-formed `content[]`, and an error is better read as JSON anyway.
 */
export function captureToToolResult(result: CaptureResult): unknown {
  if (!result.ok || !result.base64) {
    return { ok: false, error: result.error ?? "capture-failed" }
  }
  const note = `${result.filename ?? "screenshot.png"} (${result.size ?? 0} bytes)${
    result.copiedToClipboard ? ", copied to clipboard" : ""
  }`
  return {
    content: [
      { type: "text", text: note },
      { type: "image", data: result.base64, mimeType: result.mimeType ?? "image/png" },
    ],
  }
}

/**
 * Capture a screenshot and OCR it (ADR-0024). Reuses the same getDisplayMedia
 * capture as `take_screenshot`, then runs the PNG through the OCR pipeline so
 * the agent gets the screen's text instead of (or alongside) raw image bytes.
 */
/** Text block + image-relative bounding box (origin top-left, px). */
interface OcrTextBlock {
  text: string
  bbox?: { x: number; y: number; width: number; height: number }
  confidence?: number
}

async function performCaptureOcr(languages?: string[]): Promise<
  | {
      ok: true
      text: string
      markdown: string
      providerId: string
      blocks: OcrTextBlock[]
    }
  | { ok: false; error: string }
> {
  try {
    const file = await captureScreenshot()
    if (!file) return { ok: false, error: "user-cancelled-or-unsupported" }
    const base64 = await fileToBase64(file)
    const mimeType = file.type || "image/png"
    const result = await extract(
      {
        source: { kind: "data-url", dataUrl: `data:${mimeType};base64,${base64}`, mimeType },
        languages,
      },
      buildOcrDeps()
    )
    // Surface per-block geometry (when the provider emits it) so callers can map
    // text to a location. Coordinates are relative to the captured image — for
    // an actionable screen click prefer the gated click_text / find_text tools.
    const blocks: OcrTextBlock[] = (result.pages[0]?.blocks ?? []).map((b) => ({
      text: b.text,
      bbox: b.bbox,
      confidence: b.confidence,
    }))
    return {
      ok: true,
      text: result.combinedText,
      markdown: result.combinedMarkdown,
      providerId: result.providerId,
      blocks,
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

const definition: PluginDefinition = {
  // Spread plugin.json: `builtinManifest()` merges module-over-JSON, so a
  // hand-written subset here would WIN and silently drop `commands[]`.
  manifest: manifestJson as unknown as PluginManifest,
  activate: async (ctx: PluginContext) => {
    ctx.logger?.info("screenshot plugin activated")

    // ADR-0127: rich chat card for `take_screenshot` (thumbnail + caption).
    ctx.toolResult?.registerToolResultRenderer?.("take_screenshot", ScreenshotResultCard)

    ctx.agent?.registerTool?.({
      name: "take_screenshot",
      pluginId: ctx.pluginId,
      definition: {
        name: "take_screenshot",
        description:
          "Capture a screen image via getDisplayMedia and return it as an image the model can see.",
        parametersSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      } as never,
      execute: async () => captureToToolResult(await performCapture()),
    })

    ctx.agent?.registerTool?.({
      name: "extract_screenshot_ocr",
      pluginId: ctx.pluginId,
      definition: {
        name: "extract_screenshot_ocr",
        description:
          "Capture a screen image and extract its text via OCR. Returns the recognized text + markdown, plus per-block geometry (`blocks` with image-relative bboxes) when the provider supports it. To click on-screen text, use the gated click_text/find_text tools instead.",
        parametersSchema: {
          type: "object",
          properties: {
            languages: {
              type: "array",
              items: { type: "string" },
              description:
                "BCP-47 codes (e.g. en, zh). Defaults to the user's configured languages.",
            },
          },
          additionalProperties: false,
        },
      } as never,
      execute: (args?: { languages?: string[] }) => performCaptureOcr(args?.languages),
    })

    // The slash command is DECLARED in plugin.json (`commands[]`) and handled
    // here — the supported shape per the author-SDK migration table. The
    // manager owns registration (namespaced id, conflict detection, aliases,
    // command-palette entry, idle-clock refresh) and teardown, so there is no
    // imperative registry call and nothing to unregister in `deactivate`.
    return {
      onCommand: async (command: string) => {
        if (command !== "screenshot") return false
        const result = await performCapture()
        ctx.ui?.showToast?.(
          result.ok
            ? `Captured ${result.filename ?? "screenshot.png"} (${result.size ?? 0} bytes).${
                result.copiedToClipboard ? " Copied to clipboard." : ""
              }`
            : `Screenshot failed: ${result.error ?? "unknown"}`,
          result.ok ? "success" : "error"
        )
        return true
      },
    }
  },
}

export default definition
