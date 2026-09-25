/**
 * Screenshot — built-in plugin.
 *
 * Wires the host-provided capture helpers into:
 *   * an agent tool `take_screenshot` that returns the PNG as an MCP image
 *     content block (so vision models see it and the chat renders it)
 *   * an agent tool `extract_screenshot_ocr` that captures and OCRs the image
 *   * a slash command `/screenshot` that triggers the same capture from chat
 *     and drops the image into the conversation as a `screenshot-result` part
 *
 * Both tools share `captureImage`, which supports two modes: "picker" (the
 * getDisplayMedia display picker — consent is the picker itself) and "native"
 * (the policy-gated `automation.screenshot` path — no prompt, desktop only,
 * takes monitorId / region / format). The `/screenshot` command always copies
 * the PNG to the clipboard; the agent tool only does so when the call passes
 * `copyToClipboard: true`, so a model taking a frame to look at never
 * overwrites what the user copied. The copy goes through the permissioned
 * `ctx.clipboard.writeImage` host API, falling back to `navigator.clipboard`
 * on the browser shell where the native bridge doesn't exist. Failures are
 * returned as `{ ok: false, error }` rather than thrown so the manager records
 * them as tool diagnostics rather than fatal exceptions.
 *
 * Every user-facing string lives in plugin.json's `i18n` bundle: the command
 * reply and toasts through `ctx.i18n.t`, the cards through
 * `usePluginTranslations`. The capture's text block is a JSON caption
 * (`ScreenshotCaption`) — readable by the model, and localized by the card at
 * render time rather than frozen in one language when the capture was taken.
 */

import { ScreenshotOcrResultCard } from "./screenshot-ocr-result-card"
import {
  formatSize,
  ScreenshotMessagePart,
  ScreenshotResultCard,
  SCREENSHOT_PART_TYPE,
  type ScreenshotCaption,
} from "./screenshot-result-card"
import {
  definePlugin,
  definePluginManifest,
  definePluginTool,
  type PluginCommandContext,
  type PluginContext,
} from "@cognia/plugin-sdk"
import { buildOcrSecurityEnvelope } from "@cognia/plugin-sdk/api/ocr-provider"
import manifestJson from "../plugin.json"

export const manifest = definePluginManifest(manifestJson)

/**
 * Budget for the capture tools. The default picker mode blocks until the user
 * picks a screen/window (or cancels), and the OCR tool then runs a provider —
 * both routinely outlast the 30 s default tool budget.
 */
export const CAPTURE_TOOL_TIMEOUT_MS = 120_000

type CaptureMode = "picker" | "native"

interface CapturedImage {
  filename: string
  /** Byte size of the encoded image. */
  size: number
  base64: string
  mimeType: string
  /** Raw bytes — the clipboard write needs them without a second decode. */
  bytes: Uint8Array
}

const BASE64_CHUNK = 0x8000

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    // Chunked: `String.fromCharCode` spreads are call-stack-bound, so one
    // giant call overflows on multi-MB captures.
    let binary = ""
    for (let i = 0; i < bytes.byteLength; i += BASE64_CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK))
    }
    return btoa(binary)
  }
  return Buffer.from(bytes).toString("base64")
}

function base64ToBytes(base64: string): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  }
  return new Uint8Array(Buffer.from(base64, "base64"))
}

function timestampedFilename(format: string): string {
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-").replace("T", "_").replace("Z", "")
  return `screenshot-${stamp}.${format}`
}

type CaptureHost = Pick<PluginContext["automation"], "captureDisplay" | "screenshot">

/** Options the native capture path understands (`automation.screenshot`). */
interface NativeCaptureOpts {
  monitorId?: string
  region?: { x: number; y: number; width: number; height: number }
  format?: "png" | "jpeg"
}

/**
 * Pick the native-only knobs out of tool args. Unknown/invalid values are
 * dropped rather than forwarded — a malformed `region` must not reach the
 * desktop backend as a half-shape.
 */
function normalizeNativeOpts(args?: Record<string, unknown>): NativeCaptureOpts | undefined {
  if (!args) return undefined
  const opts: NativeCaptureOpts = {}
  if (typeof args.monitorId === "string" && args.monitorId.length > 0) {
    opts.monitorId = args.monitorId
  }
  const region = args.region
  if (region && typeof region === "object") {
    const { x, y, width, height } = region as Record<string, unknown>
    if ([x, y, width, height].every((v) => typeof v === "number" && Number.isFinite(v))) {
      opts.region = {
        x: x as number,
        y: y as number,
        width: width as number,
        height: height as number,
      }
    }
  }
  if (args.format === "png" || args.format === "jpeg") opts.format = args.format
  return Object.keys(opts).length > 0 ? opts : undefined
}

/**
 * Capture one frame. "picker" asks the WebView to share a display (the user
 * picks the screen/window — that pick IS the consent gesture, and it works
 * on every shell with getDisplayMedia). "native" goes through the desktop
 * automation path: no prompt, still subject to the host's per-surface
 * automation policy, and it takes `monitorId` / `region` / `format`.
 */
async function captureImage(
  automation: CaptureHost,
  mode: CaptureMode,
  nativeOpts?: NativeCaptureOpts
): Promise<CapturedImage | null> {
  if (mode === "native") {
    const shot = await automation.screenshot(nativeOpts)
    const bytes = base64ToBytes(shot.bytes)
    const format = shot.format === "jpeg" ? "jpeg" : "png"
    return {
      filename: timestampedFilename(format),
      size: bytes.byteLength,
      base64: shot.bytes,
      mimeType: `image/${format}`,
      bytes,
    }
  }
  const file = await automation.captureDisplay()
  if (!file) return null
  const bytes = new Uint8Array(await file.arrayBuffer())
  return {
    filename: file.name,
    size: file.size,
    base64: bytesToBase64(bytes),
    mimeType: file.type || "image/png",
    bytes,
  }
}

async function copyImageToClipboard(
  image: CapturedImage,
  clipboard: PluginContext["clipboard"]
): Promise<boolean> {
  // Prefer the permissioned host API: on Tauri it routes to the native
  // clipboard, where the WebView's navigator.clipboard.write is unavailable.
  try {
    await clipboard.writeImage(image.bytes, image.mimeType === "image/jpeg" ? "jpeg" : "png")
    return true
  } catch {
    // The browser shell has no native clipboard bridge (NOT_SUPPORTED) —
    // fall through to the WebView API, which does work there.
  }
  if (typeof navigator === "undefined" || !navigator.clipboard?.write) {
    return false
  }
  try {
    const item = new ClipboardItem({
      [image.mimeType]: new Blob([image.bytes as BlobPart], { type: image.mimeType }),
    })
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

interface PerformCaptureOpts {
  /**
   * Whether to copy the image onto the user's clipboard. Explicit per call:
   * `/screenshot` always copies (that's what the user asked for), while the
   * agent tool only copies on request — a model capturing frames to look at
   * must not silently overwrite whatever the user had in the clipboard.
   */
  copyToClipboard: boolean
  native?: NativeCaptureOpts
}

async function performCapture(
  ctx: Pick<PluginContext, "automation" | "clipboard">,
  mode: CaptureMode,
  opts: PerformCaptureOpts
): Promise<CaptureResult> {
  try {
    const image = await captureImage(ctx.automation, mode, opts.native)
    if (!image) {
      return { ok: false, error: "user-cancelled-or-unsupported" }
    }
    const copied = opts.copyToClipboard ? await copyImageToClipboard(image, ctx.clipboard) : false
    return {
      ok: true,
      filename: image.filename,
      size: image.size,
      base64: image.base64,
      mimeType: image.mimeType,
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
  return captureContent(result, result.base64)
}

/** The capture as `[caption, image]` content blocks — shared by the tool and `/screenshot`. */
function captureContent(result: CaptureResult, base64: string) {
  const mimeType = result.mimeType ?? "image/png"
  const caption: ScreenshotCaption = {
    ok: true,
    filename: result.filename ?? "screenshot.png",
    size: result.size ?? 0,
    mimeType,
    copiedToClipboard: result.copiedToClipboard === true,
  }
  return {
    content: [
      { type: "text", text: JSON.stringify(caption) },
      { type: "image", data: base64, mimeType },
    ],
  }
}

/**
 * Capture a screenshot and OCR it (ADR-0024). Shares `captureImage` with
 * `take_screenshot`, then runs the image through the OCR pipeline so the agent
 * gets the screen's text instead of (or alongside) raw image bytes.
 */
/** Text block + image-relative bounding box (origin top-left, px). */
interface OcrTextBlock {
  text: string
  bbox?: { x: number; y: number; width: number; height: number }
  confidence?: number
}

async function performCaptureOcr(
  ctx: Pick<PluginContext, "automation" | "ocr">,
  mode: CaptureMode,
  languages?: string[],
  nativeOpts?: NativeCaptureOpts
): Promise<
  | {
      ok: true
      text: string
      markdown: string
      providerId: string
      blocks: OcrTextBlock[]
      /**
       * The captured frame, held out of the JSON envelope on purpose: the
       * tool only emits it as an MCP image block when `includeImage` asks —
       * a base64 field inside the text payload is dead weight the model
       * cannot decode.
       */
      image: { base64: string; mimeType: string; filename: string }
    }
  | { ok: false; error: string }
> {
  try {
    const image = await captureImage(ctx.automation, mode, nativeOpts)
    if (!image) return { ok: false, error: "user-cancelled-or-unsupported" }
    const result = await ctx.ocr.extract({
      source: {
        kind: "data-url",
        dataUrl: `data:${image.mimeType};base64,${image.base64}`,
        mimeType: image.mimeType,
      },
      languages,
    })
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
      image: { base64: image.base64, mimeType: image.mimeType, filename: image.filename },
      ...buildOcrSecurityEnvelope(result, "screen"),
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

const MODE_SCHEMA = {
  type: "string",
  enum: ["picker", "native"],
  description:
    '"picker" (default) opens the system display picker — the call blocks until the user picks a screen/window or cancels, which is also the consent gesture. "native" captures a monitor with no prompt through the host automation policy; desktop only.',
} as const

const NATIVE_ONLY = "native mode only — ignored under the picker"

/** Schema shared by both tools for the `automation.screenshot` knobs. */
const NATIVE_OPTION_SCHEMA = {
  monitorId: {
    type: "string",
    description: `Capture a specific monitor (id from the host's capabilities().monitors list); falls back to the primary monitor. ${NATIVE_ONLY}.`,
  },
  region: {
    type: "object",
    properties: {
      x: { type: "number" },
      y: { type: "number" },
      width: { type: "number" },
      height: { type: "number" },
    },
    required: ["x", "y", "width", "height"],
    additionalProperties: false,
    description: `Crop rectangle in screen coordinates. ${NATIVE_ONLY}.`,
  },
  format: {
    type: "string",
    enum: ["png", "jpeg"],
    description: `Image encoding — jpeg is far smaller and keeps context cost down. ${NATIVE_ONLY}.`,
  },
} as const

function normalizeMode(mode: unknown): CaptureMode {
  return mode === "native" ? "native" : "picker"
}

const definition = definePlugin({
  manifest,
  activate: async (ctx: PluginContext) => {
    ctx.logger.info("screenshot plugin activated")

    const t = (key: string, params?: Record<string, string | number | boolean>) =>
      ctx.i18n.t(key, params)

    // ADR-0127: rich chat cards — `take_screenshot` draws a thumbnail card,
    // `extract_screenshot_ocr` draws its recognized text instead of a JSON wall.
    ctx.toolResult.registerToolResultRenderer("take_screenshot", ScreenshotResultCard)
    ctx.toolResult.registerToolResultRenderer("extract_screenshot_ocr", ScreenshotOcrResultCard)
    // The `/screenshot` command appends a `screenshot-result` part into the
    // transcript; this is the renderer that draws it (same card).
    ctx.messagePart.registerPartRenderer(SCREENSHOT_PART_TYPE, ScreenshotMessagePart)

    ctx.agent.registerTool(
      definePluginTool({
        name: "take_screenshot",
        definition: {
          name: "take_screenshot",
          description:
            "Capture a screen image and return it as an image the model can see. The default picker mode opens a display picker the user must confirm, so the call blocks on human input; pass mode='native' to capture a monitor without prompting (desktop only, still subject to the host automation policy). The image is NOT copied to the user's clipboard unless copyToClipboard=true — pass it only when the user asked for a copyable capture.",
          parametersSchema: {
            type: "object",
            properties: {
              mode: MODE_SCHEMA,
              copyToClipboard: {
                type: "boolean",
                description:
                  "Also copy the image to the user's clipboard (default false — a capture the model takes for itself must not overwrite what the user copied).",
              },
              ...NATIVE_OPTION_SCHEMA,
            },
            additionalProperties: false,
          },
          timeoutMs: CAPTURE_TOOL_TIMEOUT_MS,
        },
        execute: async (args) =>
          captureToToolResult(
            await performCapture(ctx, normalizeMode(args.mode), {
              copyToClipboard: args.copyToClipboard === true,
              native: normalizeNativeOpts(args),
            })
          ),
      })
    )

    ctx.agent.registerTool(
      definePluginTool({
        name: "extract_screenshot_ocr",
        definition: {
          name: "extract_screenshot_ocr",
          description:
            "Capture a screen image and extract its text via OCR. Returns the recognized text + markdown, plus per-block geometry (`blocks` with image-relative bboxes) when the provider supports it. The default picker mode opens a display picker the user must confirm; mode='native' captures the primary monitor without prompting (desktop only). To click on-screen text, use the gated click_text/find_text tools instead.",
          parametersSchema: {
            type: "object",
            properties: {
              mode: MODE_SCHEMA,
              languages: {
                type: "array",
                items: { type: "string" },
                description:
                  "BCP-47 codes (e.g. en, zh). Defaults to the user's configured languages.",
              },
              includeImage: {
                type: "boolean",
                description:
                  "Also return the captured frame as an image content block alongside the OCR text — one capture feeds both text and vision (default false).",
              },
              ...NATIVE_OPTION_SCHEMA,
            },
            additionalProperties: false,
          },
          timeoutMs: CAPTURE_TOOL_TIMEOUT_MS,
        },
        execute: async (args) => {
          const languages = Array.isArray(args.languages)
            ? args.languages.filter((l): l is string => typeof l === "string")
            : undefined
          const result = await performCaptureOcr(
            ctx,
            normalizeMode(args.mode),
            languages,
            normalizeNativeOpts(args)
          )
          if (!result.ok) return result
          const { image, ...envelope } = result
          if (args.includeImage === true) {
            return {
              content: [
                { type: "text", text: JSON.stringify(envelope) },
                { type: "image", data: image.base64, mimeType: image.mimeType },
              ],
            }
          }
          return envelope
        },
      })
    )

    // The monitorId knob on both capture tools is only usable if the model
    // can discover valid ids — `ctx.automation.capabilities()` is not a
    // tool, so this small read-only one is the discovery path.
    ctx.agent.registerTool(
      definePluginTool({
        name: "list_screenshot_monitors",
        definition: {
          name: "list_screenshot_monitors",
          description:
            "List the monitors the native capture backend can see — id, name, bounds in the same screen-coordinate space `region` uses, primary flag, scale factor — plus whether prompt-free native capture is available on this shell. Pass a monitor `id` to take_screenshot / extract_screenshot_ocr as `monitorId` (native mode).",
          parametersSchema: { type: "object", properties: {}, additionalProperties: false },
        },
        execute: async () => {
          try {
            const caps = await ctx.automation.capabilities()
            return { ok: true, nativeCapture: caps.hasScreenshot, monitors: caps.monitors }
          } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) }
          }
        },
      })
    )

    // The slash command is DECLARED in plugin.json (`commands[]`) and handled
    // here — the supported shape per the author-SDK migration table. The
    // manager owns registration (namespaced id, conflict detection, aliases,
    // command-palette entry, idle-clock refresh) and teardown, so there is no
    // imperative registry call and nothing to unregister in `deactivate`.
    return {
      onCommand: async (command: string, args?: string[], context?: PluginCommandContext) => {
        if (command !== "screenshot") return false
        // `/screenshot native` skips the picker (desktop only); anything else
        // — including a stray token — keeps the consent-by-picker default.
        const mode: CaptureMode = args?.includes("native") ? "native" : "picker"
        const result = await performCapture(ctx, mode, { copyToClipboard: true })
        if (!result.ok || !result.base64) {
          const message = t("toast.failed", {
            error: result.error ?? t("toast.unknownError"),
          })
          ctx.ui.showToast(message, "error")
          return { handled: true, message }
        }
        const message = `${t("toast.captured", {
          filename: result.filename ?? "screenshot.png",
          size: formatSize(result.size ?? 0),
        })}${result.copiedToClipboard ? ` ${t("toast.copied")}` : ""}`
        ctx.ui.showToast(message, "success")
        // Hand the capture to the conversation: the same content blocks the
        // tool emits (JSON caption + image), as a `screenshot-result` part the
        // registered renderer draws and localizes. Target the session the
        // command was typed in — the ambient activeSessionId can point
        // elsewhere when the command ran from the palette, a shortcut, or the CLI.
        const partId = ctx.chat.appendMessagePart(
          {
            type: SCREENSHOT_PART_TYPE,
            mcpContent: captureContent(result, result.base64).content,
          },
          context?.sessionId ? { sessionId: context.sessionId } : undefined
        )
        if (partId == null) {
          ctx.logger.warn("screenshot: no chat session to attach the capture to")
          return { handled: true, message: `${message} ${t("toast.notAttached")}` }
        }
        return { handled: true, message }
      },
    }
  },
})

export default definition
