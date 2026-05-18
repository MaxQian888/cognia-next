/**
 * OCR — built-in plugin (ADR-0024).
 *
 * Wires the existing `lib/ocr/extract()` function into:
 *   * an agent tool `ocr.extract` so the model can call OCR mid-conversation
 *   * a slash command `/ocr` that drives the same extraction from chat
 *
 * Both paths share the same handler. The plugin doesn't own the registry —
 * it expects `installOcrRuntime()` (from `lib/ocr/runtime.ts`) to have run
 * during the app's client-side bootstrap. The plugin's job is the schema
 * surface for the agent and slash dispatcher.
 */

import type { PluginContext, PluginDefinition } from "@/types/plugin"
import { registerSlashCommand, unregisterCommandsByPlugin } from "@/lib/chat/slash-command-registry"
import { extract, type ExtractDeps } from "@/lib/ocr/index"
import { getSharedOcrRegistry } from "@/lib/ocr/registry"
import {
  DEFAULT_OCR_SETTINGS,
  type OcrInput,
  type OcrResult,
  type UserOcrSettings,
} from "@/lib/ocr/types"
import { handleOcrSlashCommand } from "@/lib/slash-commands/actions/ocr"

export interface OcrToolInput {
  source: { kind: "attachment_id" | "data_url" | "file_path"; value: string }
  languages?: string[]
  format?: "markdown" | "text" | "blocks"
  provider?: string
  pageRange?: string
}

interface OcrPluginConfig {
  /** Caller can swap in custom deps in tests — defaults to lazy lookup. */
  buildDeps?: () => ExtractDeps | null
  /** Custom settings — defaults to DEFAULT_OCR_SETTINGS when no store is wired. */
  getSettings?: () => UserOcrSettings
}

/**
 * Resolve runtime deps lazily so the plugin doesn't import every store at
 * activation time. App code overrides `buildDeps` to thread the live settings
 * + keyring resolvers; tests pass `buildDeps: () => mockDeps`.
 */
function defaultDepsBuilder(): ExtractDeps | null {
  const registry = getSharedOcrRegistry()
  if (registry.list().length === 0) return null
  return {
    registry,
    settings: { ...DEFAULT_OCR_SETTINGS },
    platform: "web",
    credentialsResolver: async () => ({ secrets: {} }),
  }
}

export async function runOcrTool(
  input: OcrToolInput,
  config: OcrPluginConfig = {}
): Promise<{ ok: true; result: OcrResult } | { ok: false; error: string; code?: string }> {
  const deps = (config.buildDeps ?? defaultDepsBuilder)()
  if (!deps) {
    return { ok: false, error: "OCR runtime is not ready. Call installOcrRuntime() first." }
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
  switch (source.kind) {
    case "attachment_id":
      return { kind: "attachment-id", attachmentId: source.value }
    case "data_url":
      return { kind: "data-url", dataUrl: source.value, mimeType: extractMime(source.value) }
    case "file_path":
      return { kind: "file-path", path: source.value }
    default:
      return null
  }
}

function extractMime(dataUrl: string): string {
  const m = /^data:([^;,]+)/.exec(dataUrl)
  return m ? m[1]! : "application/octet-stream"
}

const TOOL_NAME = "ocr.extract"

const TOOL_PARAMETERS = {
  type: "object",
  properties: {
    source: {
      type: "object",
      description: "Where to read the image or PDF from.",
      required: ["kind", "value"],
      properties: {
        kind: { type: "string", enum: ["attachment_id", "data_url", "file_path"] },
        value: { type: "string" },
      },
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
  manifest: {
    id: "cognia-ocr",
    name: "OCR",
    version: "0.1.0",
    type: "frontend",
    capabilities: ["tools", "commands"],
    main: "src/index.ts",
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

    registerSlashCommand({
      id: "ocr.extract",
      name: "/ocr",
      description:
        "Extract text from an image or PDF. Usage: /ocr <file path or attachment id> [--provider auto|<id>] [--lang en,zh] [--pages 1-3] [--format markdown|text|blocks]",
      handler: async (args: string) => {
        const deps = defaultDepsBuilder()
        if (!deps) {
          return { message: "OCR runtime is not ready." }
        }
        const out = await handleOcrSlashCommand({ argv: args, deps })
        return {
          message: out.system,
          payload: out.composerText ? { dispatchPrompt: out.composerText } : undefined,
        }
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

export default ocrPluginDefinition
