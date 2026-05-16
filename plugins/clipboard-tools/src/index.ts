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
import { isTauri } from "@/lib/tauri"

async function readClipboardText(): Promise<string> {
  if (isTauri()) {
    const mod = await import("@tauri-apps/plugin-clipboard-manager")
    return mod.readText()
  }
  if (typeof navigator !== "undefined" && navigator.clipboard?.readText) {
    return navigator.clipboard.readText()
  }
  throw new Error("Clipboard read is not available in this environment.")
}

const definition: PluginDefinition = {
  // The runtime treats the manifest as the source of truth; the
  // bundled `plugin.json` next to this file is loaded by the
  // browser-builtin-registry.
  manifest: {
    id: "cognia-clipboard-tools",
    name: "Clipboard Tools",
    version: "0.1.0",
    type: "frontend",
    capabilities: ["tools"],
    main: "src/index.ts",
  } as never,
  activate: async (ctx: PluginContext) => {
    ctx.logger?.info("clipboard-tools activated")
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
  },
  deactivate: async () => {
    // Tools are unregistered by the runtime when deactivate runs;
    // nothing else to clean up since clipboard handles are per-call.
  },
}

export default definition
