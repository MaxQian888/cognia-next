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

import type { OcrInput, OcrResult, PluginContext, PluginDefinition } from "@cognia/plugin-sdk"
import { buildOcrResultPart, buildOcrSecurityEnvelope } from "@cognia/plugin-sdk/api/ocr-provider"
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
  runtime?: Pick<PluginContext["ocr"], "extract" | "extractFile" | "extractScreen" | "isReady">
}

export async function runOcrTool(
  input: OcrToolInput,
  config: OcrPluginConfig = {}
): Promise<
  | {
      ok: true
      result: OcrResult
      provenance: { kind: "ocr"; providerId: string; sourceKind: OcrToolInput["source"]["kind"] }
      security: { untrusted: true; pii: "unreviewed" }
      untrustedNotice: string
    }
  | { ok: false; error: string; code?: string }
> {
  const success = (result: OcrResult) => ({
    ok: true as const,
    result,
    ...buildOcrSecurityEnvelope(result, input.source.kind),
  })
  // `screen` mode captures the desktop and OCRs it (renderer composition; the
  // capture half is gated by the automation permission layer). It builds its
  // own deps via `ocrScreen`, so it runs before the registry-deps check and
  // needs no `source.value`.
  const runtime = config.runtime
  if (!runtime || !runtime.isReady()) {
    return {
      ok: false,
      error: "OCR runtime is not ready — no providers registered yet.",
    }
  }

  if (input.source.kind === "screen") {
    try {
      const result = await runtime.extractScreen({ languages: input.languages })
      return success(result)
    } catch (err) {
      const code = (err as { code?: string }).code
      return { ok: false, error: err instanceof Error ? err.message : String(err), code }
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
    const result =
      source.kind === "file-path"
        ? await runtime.extractFile(source.path, {
            languages: input.languages,
            format: input.format,
            pageRange: input.pageRange,
            providerId: input.provider && input.provider !== "auto" ? input.provider : undefined,
          })
        : await runtime.extract(ocrInput)
    return success(result)
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
    chat = ctx.chat
    ctx.agent?.registerTool?.({
      name: TOOL_NAME,
      pluginId: ctx.pluginId,
      definition: {
        name: TOOL_NAME,
        description:
          "Extract text and structured Markdown from any image or PDF. Routes to one of 17 cloud or on-device OCR providers based on settings or the supplied provider id.",
        parametersSchema: TOOL_PARAMETERS,
      } as never,
      execute: async (args: Record<string, unknown>) =>
        runOcrTool(args as unknown as OcrToolInput, { runtime: ctx.ocr }),
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
        if (!ctx.ocr.isReady()) {
          ctx.ui?.showToast?.("OCR runtime is not ready.", "error")
          return true
        }
        const out = await ctx.ocr.runSlashCommand(args.join(" "))
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
    chat = undefined
  },
}

/** Disposer for the `ocr-result` part renderer (set on activate). */
let disposeOcrRenderer: (() => void) | undefined
/**
 * `ctx.chat`, captured at activation: the slash-command handler runs outside
 * `activate(ctx)` and is handed no context.
 */
let chat: PluginContext["chat"] | undefined

/** Append an `ocr-result` system message to the active chat session. */
async function appendOcrResultMessage(part: ReturnType<typeof buildOcrResultPart>): Promise<void> {
  try {
    // `ctx.chat.appendMessagePart` owns the envelope (id, system role,
    // ordering); the plugin supplies only the part its own renderer draws.
    chat?.appendMessagePart(part)
  } catch {
    // best-effort — a store/runtime hiccup must not fail the OCR command.
  }
}

export default ocrPluginDefinition
