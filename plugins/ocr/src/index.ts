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

import type { PluginContext, PluginDefinition } from "@/types/plugin"
import { registerSlashCommand, unregisterCommandsByPlugin } from "@/lib/slash-commands/registry"
import { extract, type ExtractDeps } from "@/lib/ocr/index"
import { getSharedOcrRegistry } from "@/lib/ocr/registry"
import { buildOcrDeps } from "@/lib/ocr/deps"
import { type OcrInput, type OcrResult, type UserOcrSettings } from "@/types/ocr"
import { handleOcrSlashCommand } from "@/lib/slash-commands/actions/ocr"

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
 * Resolve runtime deps lazily so the plugin doesn't import every store at
 * activation time. Delegates to the canonical `buildOcrDeps()` so the plugin
 * tool / `/ocr` get the real keyring-backed credentials resolver, platform
 * detection, and OS-tag routing — not the empty-secrets stub it used before.
 * Returns null when no providers are registered yet (runtime not booted), so
 * callers surface a clear "runtime not ready" message. App code can pass
 * `config.getSettings`; tests pass `buildDeps: () => mockDeps`.
 */
function defaultDepsBuilder(config: OcrPluginConfig = {}): ExtractDeps | null {
  const registry = getSharedOcrRegistry()
  if (registry.list().length === 0) return null
  return buildOcrDeps({ registry, settings: config.getSettings?.() })
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

  const deps = config.buildDeps ? config.buildDeps() : defaultDepsBuilder(config)
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

const TOOL_PARAMETERS = {
  type: "object",
  properties: {
    source: {
      type: "object",
      description: "Where to read the image or PDF from.",
      properties: {
        kind: { type: "string", enum: ["attachment_id", "data_url", "file_path", "screen"] },
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
