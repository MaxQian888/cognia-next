/**
 * OCR — built-in plugin (ADR-0024).
 *
 * Wires the host OCR subsystem into:
 *   * an agent tool `ocr.extract` so the model can call OCR mid-conversation
 *   * a slash command `/ocr` that drives the same extraction from chat
 *
 * The plugin is a **consumer** of the shared OCR registry — it does not
 * register providers itself. The host's `installOcrRuntime()`
 * (`lib/ocr/runtime.ts`) registers the built-in providers during client-side
 * bootstrap; *additional* provider plugins use ADR-0026 §2 §A's
 * `ctx.ocr.registerProvider(...)` or `manifest.ocrProviders[]`. Both paths
 * funnel through the same registry `ctx.ocr` reads from.
 *
 * File reads are confined: a model-supplied file lives in the TOP-LEVEL `path`
 * parameter, which the tool declares with `access: "read"` + `pathParams`, so
 * the sidecar's workspace confinement judges it before the call reaches the
 * host (credential paths hard-denied, out-of-root reads refused). The legacy
 * nested `source: { kind: "file_path" }` form is rejected — a nested field is
 * invisible to that gate, so honouring it would let the model read any file
 * the desktop process can.
 */

import {
  definePlugin,
  definePluginManifest,
  definePluginTool,
  type OcrInput,
  type OcrResult,
  type PluginCommandContext,
  type PluginContext,
} from "@cognia/plugin-sdk"
import { buildOcrResultPart, buildOcrSecurityEnvelope } from "@cognia/plugin-sdk/api/ocr-provider"
import { OcrResultCard } from "./ocr-result-card"
import manifestJson from "../plugin.json"

export const manifest = definePluginManifest(manifestJson)

/** Source kinds the tool reads through `source` (files go through `path`). */
export type OcrSourceKind = "data_url" | "screen"

export interface OcrToolInput {
  /** Image / PDF file to read — confined by the sidecar workspace gate. */
  path?: string
  source?: { kind: OcrSourceKind | "attachment_id"; value?: string }
  languages?: string[]
  format?: "markdown" | "text" | "blocks"
  provider?: string
  pageRange?: string
}

/** Provenance `sourceKind` — what the text was read from. */
type SourceKind = OcrSourceKind | "attachment_id" | "file_path"

interface OcrPluginConfig {
  runtime?: Pick<PluginContext["ocr"], "extract" | "extractFile" | "extractScreen" | "isReady">
}

type OcrToolResult =
  | {
      ok: true
      result: OcrResult
      provenance: { kind: "ocr"; providerId: string; sourceKind: SourceKind }
      security: { untrusted: true; pii: "unreviewed" }
      untrustedNotice: string
    }
  | { ok: false; error: string; code?: string }

/**
 * Budget for one `ocr.extract` call: a multi-page PDF or a cloud provider
 * round trip routinely outlasts the 30 s default tool budget.
 */
export const OCR_TOOL_TIMEOUT_MS = 120_000

function failure(err: unknown): { ok: false; error: string; code?: string } {
  const code = (err as { code?: unknown } | null)?.code
  return {
    ok: false,
    error: err instanceof Error ? err.message : String(err),
    ...(typeof code === "string" ? { code } : {}),
  }
}

export async function runOcrTool(
  input: OcrToolInput,
  config: OcrPluginConfig = {}
): Promise<OcrToolResult> {
  const runtime = config.runtime
  if (!runtime || !runtime.isReady()) {
    return { ok: false, error: "OCR runtime is not ready — no providers registered yet." }
  }
  const providerId = input.provider && input.provider !== "auto" ? input.provider : undefined
  const hasPath = typeof input.path === "string" && input.path.trim().length > 0
  const source = input.source
  if (hasPath && source) {
    return { ok: false, error: "Pass either `path` or `source`, not both." }
  }
  if (!hasPath && !source) {
    return { ok: false, error: "Pass `path` (an image or PDF file) or `source`." }
  }
  const success = (result: OcrResult, sourceKind: SourceKind) => ({
    ok: true as const,
    result,
    ...buildOcrSecurityEnvelope(result, sourceKind),
  })

  try {
    if (hasPath) {
      const result = await runtime.extractFile(input.path!.trim(), {
        languages: input.languages,
        format: input.format,
        pageRange: input.pageRange,
        providerId,
      })
      return success(result, "file_path")
    }
    // `source` is non-null here: exactly one of path/source was supplied.
    const { kind, value } = source!
    if (kind === "screen") {
      // Captures the desktop and OCRs it; the capture half is gated by the
      // automation permission layer. Needs no `value`.
      return success(await runtime.extractScreen({ languages: input.languages }), "screen")
    }
    if ((kind as string) === "file_path") {
      return {
        ok: false,
        error:
          'Pass a file as the top-level `path` parameter; `source.kind: "file_path"` is not accepted.',
      }
    }
    if (kind !== "data_url" && kind !== "attachment_id") {
      return { ok: false, error: `Unknown source kind: ${String(kind)}` }
    }
    const mapped = mapToolSource(kind, value)
    if (!mapped) return { ok: false, error: `\`source.value\` is required for kind "${kind}".` }
    const ocrInput: OcrInput = {
      source: mapped,
      languages: input.languages,
      format: input.format,
      pageRange: input.pageRange,
      providerId,
    }
    return success(await runtime.extract(ocrInput), kind)
  } catch (err) {
    return failure(err)
  }
}

function mapToolSource(
  kind: "data_url" | "attachment_id",
  value: string | undefined
): OcrInput["source"] | null {
  if (typeof value !== "string" || value.length === 0) return null
  return kind === "attachment_id"
    ? { kind: "attachment-id", attachmentId: value }
    : { kind: "data-url", dataUrl: value, mimeType: extractMime(value) }
}

function extractMime(dataUrl: string): string {
  const m = /^data:([^;,]+)/.exec(dataUrl)
  return m ? m[1]! : "application/octet-stream"
}

const TOOL_NAME = "ocr.extract"

/** Exported for the conformance test that pins the advertised source kinds. */
export const TOOL_PARAMETERS = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description:
        "Path of an image or PDF file to read (workspace-relative or absolute inside the workspace). Use this for files; omit `source`.",
    },
    source: {
      type: "object",
      description:
        "A non-file source: an inline data URL, or the current screen. Omit when `path` is set.",
      properties: {
        // `attachment_id` is deliberately NOT advertised: nothing in the app
        // produces an id an `attachmentResolver` could resolve, so offering it
        // to the model only yields a guaranteed resolver error. The mapping
        // still accepts it for a caller that wires its own resolver.
        kind: { type: "string", enum: ["data_url", "screen"] },
        value: {
          type: "string",
          description: "The data URL for kind=data_url. Omit for kind=screen.",
        },
      },
      required: ["kind"],
      additionalProperties: false,
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
  additionalProperties: false,
} as const

export const ocrPluginDefinition = definePlugin({
  manifest,
  activate: async (ctx: PluginContext) => {
    ctx.logger.info("ocr plugin activated")
    const t = (key: string, params?: Record<string, string | number>) => ctx.i18n.t(key, params)

    ctx.agent.registerTool(
      definePluginTool({
        name: TOOL_NAME,
        definition: {
          name: TOOL_NAME,
          description:
            "Extract text and structured Markdown from an image or PDF file (`path`), an inline data URL, or the current screen. Uses the OCR provider selected in settings (the auto-router by default) unless a provider id is given.",
          // `path` is a filesystem read: the sidecar confinement gate checks it.
          access: "read",
          pathParams: ["path"],
          timeoutMs: OCR_TOOL_TIMEOUT_MS,
          parametersSchema: TOOL_PARAMETERS as unknown as Record<string, unknown>,
        },
        execute: async (args) => runOcrTool(args as OcrToolInput, { runtime: ctx.ocr }),
      })
    )

    // gap4 — render the recognized text as a rich `ocr-result` chat card
    // instead of a plain markdown bubble. Registered here (startup-activated),
    // before any `/ocr` can produce a part, so the part always has a renderer.
    ctx.messagePart.registerPartRenderer("ocr-result", OcrResultCard)

    // The slash command is DECLARED in plugin.json (`commands[]`) and handled
    // here. `hooks.onCommand` receives whitespace-split argv; `/ocr` takes a
    // single path or URL argument, so rejoining is lossless for it.
    return {
      onCommand: async (command: string, args: string[], context?: PluginCommandContext) => {
        if (command !== "ocr") return false
        if (!ctx.ocr.isReady()) {
          return { handled: true, message: t("command.notReady") }
        }
        const out = await ctx.ocr.runSlashCommand(args.join(" "))
        if (!out.result) {
          // Usage / validation text from the host's canonical `/ocr` parser.
          return { handled: true, message: out.system || t("command.failed") }
        }
        // Emit the rich `ocr-result` card into the chat the command was typed
        // in — the focused chat can be a different one when the command ran
        // from the palette or a shortcut.
        const messageId = ctx.chat.appendMessagePart(
          buildOcrResultPart(out.result, out.sourceRef),
          context?.sessionId ? { sessionId: context.sessionId } : undefined
        )
        if (messageId == null) {
          // No chat to hold the card: answer with the text itself so the
          // result is not lost.
          return {
            handled: true,
            message: `${t("command.notAttached")}\n\n${out.result.combinedMarkdown}`,
          }
        }
        return {
          handled: true,
          message: t("command.done", { provider: out.result.providerId }),
        }
      },
    }
  },
})

export default ocrPluginDefinition
