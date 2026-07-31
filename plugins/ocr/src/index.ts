/**
 * OCR — built-in plugin (ADR-0024).
 *
 * Wires the existing `lib/ocr/extract()` function into:
 *   * an agent tool `ocr.extract` so the model can call OCR mid-conversation
 *   * a slash command `/ocr` that drives the same extraction from chat
 *
 * Both paths share the same handler.
 *
 * The plugin is a **consumer** of the shared OCR registry — it does not
 * register providers itself. The host's `installOcrRuntime()`
 * (`lib/ocr/runtime.ts`) registers the 20 built-in providers during
 * client-side bootstrap; *additional* provider plugins use ADR-0026
 * §2 §A's `ctx.ocr.registerProvider(...)` or `manifest.ocrProviders[]`
 * to contribute their own. Both paths funnel through the same
 * `getSharedOcrRegistry()` this dispatcher reads from.
 */

import type { UIMessage } from "ai"
import type { PluginContext, PluginDefinition } from "@/types/plugin"
import { extract, type ExtractDeps } from "@/lib/ocr/index"
import { getSharedOcrRegistry } from "@/lib/ocr/registry"
import { isTauri } from "@/lib/tauri"
import { buildOcrDeps } from "@/lib/ocr/deps"
import { type OcrInput, type OcrResult, type UserOcrSettings } from "@/types/ocr"
import { buildOcrResultPart, handleOcrSlashCommand } from "@/lib/slash-commands/actions/ocr"
import { OcrResultCard } from "./ocr-result-card"
import manifestJson from "../plugin.json"

export interface OcrToolInput {
  source: { kind: "attachment_id" | "data_url" | "file_path" | "screen"; value?: string }
  languages?: string[]
  format?: "markdown" | "text" | "blocks"
  provider?: string
  pageRange?: string
}

interface OcrPluginConfig {
  /** Caller can swap in custom deps in tests — defaults to lazy lookup. */
  buildDeps?: () => ExtractDeps | null
  /** Screen-OCR capture override (tests). Defaults to `lib/automation/ocr-screen`. */
  captureScreen?: (languages?: string[]) => Promise<OcrResult>
  /** Custom settings — defaults to DEFAULT_OCR_SETTINGS when no store is wired. */
  getSettings?: () => UserOcrSettings
}

/**
 * Read a file from disk into the `ResolvedSource` shape `extract` wants.
 *
 * Desktop-only: the browser has no path-addressable filesystem. Without this
 * `buildOcrDeps` left `filePathResolver` undefined, so EVERY `file-path`
 * extraction — including the documented `/ocr <path>` usage — threw
 * "file-path source requires a filePathResolver".
 */
async function readFilePathSource(path: string): Promise<{
  blob: Blob
  mimeType: string
  bytes: Uint8Array
}> {
  if (!isTauri()) {
    throw new Error("file-path OCR requires the desktop app (no filesystem access in the browser).")
  }
  const { readFile } = await import("@tauri-apps/plugin-fs")
  const bytes = await readFile(path)
  const mimeType = mimeFromPath(path)
  return { blob: new Blob([bytes as BlobPart], { type: mimeType }), mimeType, bytes }
}

const EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  heic: "image/heic",
  pdf: "application/pdf",
}

function mimeFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? ""
  return EXT_MIME[ext] ?? "application/octet-stream"
}

/** Exported so tests can assert the resolvers the plugin actually supplies. */
export async function defaultDepsBuilder(
  config: OcrPluginConfig = {}
): Promise<ExtractDeps | null> {
  const registry = getSharedOcrRegistry()
  if (registry.list().length === 0) return null
  // Read the USER's OCR settings. `buildOcrDeps` falls back to
  // DEFAULT_OCR_SETTINGS, so the tool used to silently ignore the configured
  // provider, languages and format while its own description promised
  // "routes … based on settings".
  const settings = config.getSettings?.() ?? (await loadUserOcrSettings())
  return buildOcrDeps({ registry, settings, filePathResolver: readFilePathSource })
}

/** Best-effort read of the persisted OCR settings; falls back to the defaults. */
async function loadUserOcrSettings(): Promise<UserOcrSettings | undefined> {
  try {
    const { getSettings } = await import("@/lib/db/settings")
    return (await getSettings())?.ocrSettings
  } catch {
    return undefined
  }
}

export async function runOcrTool(
  input: OcrToolInput,
  config: OcrPluginConfig = {}
): Promise<{ ok: true; result: OcrResult } | { ok: false; error: string; code?: string }> {
  // `screen` mode captures the desktop and OCRs it (renderer composition; the
  // capture half is gated by the automation permission layer). It builds its
  // own deps via `ocrScreen`, so it runs before the registry-deps check and
  // needs no `source.value`.
  if (input.source.kind === "screen") {
    try {
      const capture = config.captureScreen ?? defaultCaptureScreen
      const result = await capture(input.languages)
      return { ok: true, result }
    } catch (err) {
      const code = (err as { code?: string }).code
      return { ok: false, error: err instanceof Error ? err.message : String(err), code }
    }
  }

  const deps = config.buildDeps ? config.buildDeps() : await defaultDepsBuilder(config)
  if (!deps) {
    return {
      ok: false,
      error:
        "OCR runtime is not ready — no providers registered yet. " +
        "Providers contributed via ADR-0026 §2 §A `ctx.ocr.registerProvider(...)` " +
        "or `manifest.ocrProviders[]` populate the shared registry at activate time.",
    }
  }

  const source = mapToolSource(input.source)
  if (!source) {
    return { ok: false, error: `Unknown source kind: ${input.source.kind}` }
  }
  const ocrInput: OcrInput = {
    source,
    languages: input.languages,
    format: input.format,
    pageRange: input.pageRange,
    providerId: input.provider && input.provider !== "auto" ? input.provider : undefined,
  }
  try {
    const result = await extract(ocrInput, deps)
    return { ok: true, result }
  } catch (err) {
    const code = (err as { code?: string }).code
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: message, code }
  }
}

function mapToolSource(source: OcrToolInput["source"]): OcrInput["source"] | null {
  const value = source.value
  if (typeof value !== "string" || value.length === 0) return null
  switch (source.kind) {
    case "attachment_id":
      return { kind: "attachment-id", attachmentId: value }
    case "data_url":
      return { kind: "data-url", dataUrl: value, mimeType: extractMime(value) }
    case "file_path":
      return { kind: "file-path", path: value }
    default:
      return null
  }
}

function extractMime(dataUrl: string): string {
  const m = /^data:([^;,]+)/.exec(dataUrl)
  return m ? m[1]! : "application/octet-stream"
}

/**
 * Capture the screen and OCR it. Dynamically imports the automation client so
 * the screen-OCR path doesn't pull desktop automation into the base bundle for
 * the common image/PDF cases. The capture is gated by the automation
 * permission layer (surface/tier) on the Rust side.
 */
async function defaultCaptureScreen(languages?: string[]): Promise<OcrResult> {
  const { ocrScreen } = await import("@/lib/automation/ocr-screen")
  return ocrScreen({ languages })
}

const TOOL_NAME = "ocr.extract"

/** Exported for the conformance test that pins the advertised source kinds. */
export const TOOL_PARAMETERS = {
  type: "object",
  properties: {
    source: {
      type: "object",
      description: "Where to read the image or PDF from.",
      properties: {
        // `attachment_id` is deliberately NOT advertised: nothing in the app
        // produces an id an `attachmentResolver` could resolve (the
        // `connectorAttachments` cache is keyed by [adapterId+remoteRef] and
        // has no reader), so offering it to the model only yields a guaranteed
        // "attachment-id source requires an attachmentResolver" error. The
        // mapping below still accepts it for any caller that wires its own
        // resolver via `config.buildDeps`.
        kind: { type: "string", enum: ["data_url", "file_path", "screen"] },
        value: {
          type: "string",
          description: "Identifier for the source. Omit for kind=screen.",
        },
      },
      required: ["kind"],
    },
    languages: {
      type: "array",
      items: { type: "string" },
      description: "BCP-47 codes (e.g. en, zh). Defaults to the user's configured languages.",
    },
    format: { type: "string", enum: ["markdown", "text", "blocks"] },
    provider: {
      type: "string",
      description: 'Provider id (or "auto" to defer to the auto-router).',
    },
    pageRange: {
      type: "string",
      description: 'Optional page range, e.g. "1,3-5".',
    },
  },
  required: ["source"],
  additionalProperties: false,
} as const

export const ocrPluginDefinition: PluginDefinition = {
  // Spread plugin.json: `builtinManifest()` merges module-over-JSON, so a
  // hand-written subset here WINS and would silently drop `commands[]`.
  manifest: {
    ...(manifestJson as object),
  } as never,
  activate: async (ctx: PluginContext) => {
    ctx.logger?.info("ocr plugin activated")
    ctx.agent?.registerTool?.({
      name: TOOL_NAME,
      pluginId: ctx.pluginId,
      definition: {
        name: TOOL_NAME,
        description:
          "Extract text and structured Markdown from any image or PDF. Routes to one of 17 cloud or on-device OCR providers based on settings or the supplied provider id.",
        parametersSchema: TOOL_PARAMETERS,
      } as never,
      execute: async (args: Record<string, unknown>) => runOcrTool(args as unknown as OcrToolInput),
    })

    // gap4 — render the recognized text as a rich `ocr-result` chat card
    // instead of a plain markdown bubble. Registered here (startup-activated),
    // before any `/ocr` can produce a part, so the part always has a renderer.
    const messagePart = (
      ctx as {
        messagePart?: {
          registerPartRenderer?: (type: string, c: typeof OcrResultCard) => () => void
        }
      }
    ).messagePart
    disposeOcrRenderer = messagePart?.registerPartRenderer?.("ocr-result", OcrResultCard)

    // The slash command is DECLARED in plugin.json (`commands[]`) and handled
    // here. `hooks.onCommand` receives whitespace-split argv, so the raw tail
    // is rejoined for handlers that parse their own argument string.
    return {
      onCommand: async (command: string, args: string[]) => {
        if (command !== "ocr") return false
        const deps = await defaultDepsBuilder()
        if (!deps) {
          ctx.ui?.showToast?.("OCR runtime is not ready.", "error")
          return true
        }
        const out = await handleOcrSlashCommand({ argv: args.join(" "), deps })
        // On success emit the rich `ocr-result` card into the active chat
        // rather than a plain text bubble.
        if (out.result) {
          await appendOcrResultMessage(buildOcrResultPart(out.result, out.sourceRef))
        } else if (out.system) {
          ctx.ui?.showToast?.(out.system, "info")
        }
        return true
      },
    }
  },
  deactivate: async () => {
    disposeOcrRenderer?.()
    disposeOcrRenderer = undefined
  },
}

/** Disposer for the `ocr-result` part renderer (set on activate). */
let disposeOcrRenderer: (() => void) | undefined
/** Monotonic counter for unique system-message ids (avoids Math.random). */
let ocrMessageSeq = 0

/** Append an `ocr-result` system message to the active chat session. */
async function appendOcrResultMessage(part: ReturnType<typeof buildOcrResultPart>): Promise<void> {
  try {
    const { useChatStore } = await import("@/stores/chat/chat-store")
    useChatStore.getState().appendMessage({
      id: `sys-ocr-${Date.now()}-${(ocrMessageSeq += 1)}`,
      role: "system",
      parts: [part],
    } as unknown as UIMessage)
  } catch {
    // best-effort — a store/runtime hiccup must not fail the OCR command.
  }
}

export default ocrPluginDefinition
