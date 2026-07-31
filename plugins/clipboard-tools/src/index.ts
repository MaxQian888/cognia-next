/**
 * Clipboard Tools — built-in plugin.
 *
 * Registers a `clipboard_status` agent tool that returns the current
 * clipboard contents (browser only) and a small set of helpers plugin
 * authors can use directly. Real clipboard IO routes through the
 * browser Clipboard API; in Tauri builds we go through the OS
 * clipboard via `@tauri-apps/plugin-clipboard-manager`.
 */

import type { PluginContext, PluginDefinition } from "@/types/plugin"
import { defineWorkflowNode } from "@cognia/plugin-sdk"
// `isTauri` retained as fallback when host doesn't expose
// `ctx.capabilities.tauri` (ADR-0026 §5 §C).
import { isTauri } from "@/lib/tauri"

/**
 * Cached `tauri` flag — set by `activate()` from `ctx.capabilities.tauri`
 * when the host exposes ADR-0026 §5 §C, otherwise falls back to the
 * direct `isTauri()` import. Module-scoped so the tool executor (which
 * doesn't receive the plugin context as an argument) can read it without
 * threading `ctx` through every call site.
 */
let tauriHostFlag: boolean | undefined
let disposeClipboardWorkflowNode: (() => void) | null = null

function resolveTauriHost(): boolean {
  if (tauriHostFlag !== undefined) return tauriHostFlag
  return isTauri()
}

async function readClipboardText(): Promise<string> {
  if (resolveTauriHost()) {
    const mod = await import("@tauri-apps/plugin-clipboard-manager")
    return mod.readText()
  }
  if (typeof navigator !== "undefined" && navigator.clipboard?.readText) {
    return navigator.clipboard.readText()
  }
  throw new Error("Clipboard read is not available in this environment.")
}

const clipboardReadTextNode = defineWorkflowNode({
  kind: "action.readText",
  typeVersion: 1,
  category: "plugin",
  label: "Read clipboard text",
  description: "Read the current OS or browser clipboard text.",
  iconName: "Clipboard",
  keywords: ["clipboard", "pasteboard", "copy", "text", "read"],
  paramsSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  defaultParams: {},
  retryable: false,
  execute: async () => {
    try {
      const content = await readClipboardText()
      return { output: { ok: true, content } }
    } catch (err) {
      return { output: { ok: false, error: err instanceof Error ? err.message : String(err) } }
    }
  },
})

const definition: PluginDefinition = {
  // The runtime treats the manifest as the source of truth; the
  // bundled `plugin.json` next to this file is loaded by the
  // browser-builtin-registry.
  manifest: {
    id: "cognia-clipboard-tools",
    name: "Clipboard Tools",
    version: "0.1.0",
    type: "frontend",
    capabilities: ["tools", "workflow"],
    main: "src/index.ts",
  } as never,
  activate: async (ctx: PluginContext) => {
    ctx.logger?.info("clipboard-tools activated")
    disposeClipboardWorkflowNode?.()
    disposeClipboardWorkflowNode = null
    tauriHostFlag = ctx.capabilities?.tauri ?? isTauri()
    ctx.agent?.registerTool?.({
      name: "clipboard_status",
      pluginId: ctx.pluginId,
      definition: {
        name: "clipboard_status",
        description: "Read the current OS / browser clipboard text.",
        parametersSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      } as never,
      execute: async () => {
        try {
          const content = await readClipboardText()
          return { ok: true, content }
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      },
    })
    disposeClipboardWorkflowNode = ctx.workflow.registerNode(clipboardReadTextNode)
  },
  deactivate: async () => {
    // Tools are unregistered by the runtime when deactivate runs;
    // workflow nodes are owned by this module-level disposer.
    disposeClipboardWorkflowNode?.()
    disposeClipboardWorkflowNode = null
    tauriHostFlag = undefined
  },
}

export default definition
