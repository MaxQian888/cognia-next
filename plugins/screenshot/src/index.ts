/**
 * Screenshot — built-in plugin.
 *
 * Wires the host-provided `captureScreenshot()` helper into:
 *   * an agent tool `take_screenshot` that returns a base64 PNG payload
 *   * a slash command `/screenshot` that triggers the same capture from chat
 *
 * Both paths share the same capture function; on success they also write the
 * PNG to the clipboard (when the runtime allows). Failures are returned as
 * `{ ok: false, error }` rather than thrown so the manager records them as
 * tool diagnostics rather than fatal exceptions.
 */

import type { PluginContext, PluginDefinition } from "@/types/plugin"
import { captureScreenshot } from "@/lib/ui/screenshot"
import { registerSlashCommand, unregisterCommandsByPlugin } from "@/lib/slash-commands/registry"
import { extract } from "@/lib/ocr"
import { buildOcrDeps } from "@/lib/ocr/deps"

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

async function performCapture(): Promise<{
  ok: boolean
  filename?: string
  size?: number
  base64?: string
  copiedToClipboard?: boolean
  error?: string
}> {
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
      copiedToClipboard: copied,
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Capture a screenshot and OCR it (ADR-0024). Reuses the same getDisplayMedia
 * capture as `take_screenshot`, then runs the PNG through the OCR pipeline so
 * the agent gets the screen's text instead of (or alongside) raw image bytes.
 */
async function performCaptureOcr(
  languages?: string[]
): Promise<
  { ok: true; text: string; markdown: string; providerId: string } | { ok: false; error: string }
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
    return {
      ok: true,
      text: result.combinedText,
      markdown: result.combinedMarkdown,
      providerId: result.providerId,
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

const definition: PluginDefinition = {
  manifest: {
    id: "cognia-screenshot",
    name: "Screenshot",
    version: "0.1.0",
    type: "frontend",
    capabilities: ["tools", "commands"],
    main: "src/index.ts",
  } as never,
  activate: async (ctx: PluginContext) => {
    ctx.logger?.info("screenshot plugin activated")

    ctx.agent?.registerTool?.({
      name: "take_screenshot",
      pluginId: ctx.pluginId,
      definition: {
        name: "take_screenshot",
        description:
          "Capture a screen image via getDisplayMedia and return the PNG payload as base64.",
        parametersSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      } as never,
      execute: () => performCapture(),
    })

    ctx.agent?.registerTool?.({
      name: "extract_screenshot_ocr",
      pluginId: ctx.pluginId,
      definition: {
        name: "extract_screenshot_ocr",
        description:
          "Capture a screen image and extract its text via OCR. Returns the recognized text + markdown.",
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

    registerSlashCommand({
      id: "screenshot.capture",
      name: "/screenshot",
      description: "Capture a screen image and copy it to the clipboard.",
      handler: async () => {
        const result = await performCapture()
        return result.ok
          ? {
              message: `Captured ${result.filename ?? "screenshot.png"} (${result.size ?? 0} bytes).${
                result.copiedToClipboard ? " Copied to clipboard." : ""
              }`,
            }
          : { message: `Screenshot failed: ${result.error ?? "unknown"}` }
      },
      source: "plugin",
      pluginId: ctx.pluginId,
    })
  },
  deactivate: async (ctx?: PluginContext) => {
    if (ctx?.pluginId) {
      unregisterCommandsByPlugin(ctx.pluginId)
    }
  },
}

export default definition
