/**
 * Browser Tools — built-in plugin exposing the agent browser loop over the
 * embedded preview webview (ADR-0055). Tools target elements by `ref` from the
 * latest `browser_snapshot`; every mutating action returns a refreshed snapshot
 * so the model always acts on the current tree.
 *
 * Phase 1 drives the in-app embedded webview (lib/browser/agent-engine →
 * browserClient → browser_embed_* Tauri commands). Trust-tier routing is in
 * `routeEngine`; the embedded engine is the only backend until Phase 2 adds the
 * external-MCP engine for public sites.
 */
import type { PluginContext, PluginDefinition } from "@/types/plugin"
import { routeEngine } from "@/lib/browser/agent-engine"
import { defineContextProvider } from "@cognia/plugin-sdk"

// The URL the human/agent last navigated the preview to — used to pick the
// engine for subsequent ref-based calls (Phase 1 always embedded).
let lastUrl = "http://localhost:3000/"

function engineFor() {
  return routeEngine(lastUrl)
}

async function withSnapshot(result: Record<string, unknown>) {
  const snapshot = await engineFor().engine.snapshot()
  return { ...result, snapshot }
}

interface RegisterToolArgs {
  name: string
  pluginId: string
  definition: unknown
  execute: (args: unknown) => Promise<unknown>
}

const definition: PluginDefinition = {
  manifest: {
    id: "cognia-browser-tools",
    name: "Browser Tools",
    version: "0.1.0",
    type: "frontend",
    capabilities: ["tools"],
    main: "src/index.ts",
  } as never,
  activate: async (ctx: PluginContext) => {
    ctx.logger?.info("browser-tools activated")

    ctx.agent?.context?.registerProvider?.(
      defineContextProvider({
        id: "browser-tools:availability",
        name: "Browser tools availability",
        provide: () =>
          "Browser tools are available for the in-app preview: browser_navigate, browser_snapshot (a11y tree with refs), browser_click/type/fill_form/select/hover (target by ref), browser_read_console, browser_read_network, browser_get_page. Always take a fresh browser_snapshot after navigation or any mutating action, and act on elements by the `ref` from the latest snapshot.",
      })
    )

    const register = ctx.agent?.registerTool
    if (!register) return
    const reg = (t: RegisterToolArgs) => register.call(ctx.agent, t as never)

    reg({
      name: "browser_navigate",
      pluginId: ctx.pluginId,
      definition: {
        name: "browser_navigate",
        description: "Navigate the in-app preview to an http(s) URL and return a fresh snapshot.",
        parametersSchema: {
          type: "object",
          properties: { url: { type: "string" } },
          required: ["url"],
        },
      },
      execute: async (args) => {
        const url = String((args as { url?: string })?.url ?? "")
        lastUrl = url
        const { engine, untrusted } = engineFor()
        await engine.navigate(url)
        return { ...(await withSnapshot({ navigated: url })), untrusted }
      },
    })

    reg({
      name: "browser_snapshot",
      pluginId: ctx.pluginId,
      definition: {
        name: "browser_snapshot",
        description:
          "Capture the accessibility-tree snapshot of the preview. Returns ref'd nodes; prefer this over a screenshot.",
        parametersSchema: { type: "object", properties: {} },
      },
      execute: async () => engineFor().engine.snapshot(),
    })

    const actTool = (
      name: string,
      action: string,
      extra: Record<string, unknown>,
      required: string[],
      desc: string
    ) =>
      reg({
        name,
        pluginId: ctx.pluginId,
        definition: {
          name,
          description: desc,
          parametersSchema: {
            type: "object",
            properties: { ref: { type: "string" }, ...extra },
            required,
          },
        },
        execute: async (args) => {
          const a = (args ?? {}) as Record<string, unknown>
          const ref = String(a.ref ?? "")
          const callArgs: Record<string, unknown> = {}
          if ("text" in a) callArgs.text = a.text
          if ("value" in a) callArgs.value = a.value
          const result = await engineFor().engine.act(ref, action, callArgs)
          return withSnapshot({ result })
        },
      })

    actTool("browser_click", "click", {}, ["ref"], "Click the element with the given ref.")
    actTool(
      "browser_type",
      "type",
      { text: { type: "string" } },
      ["ref", "text"],
      "Type text into the ref'd field."
    )
    actTool(
      "browser_fill_form",
      "fill",
      { text: { type: "string" } },
      ["ref", "text"],
      "Replace the ref'd field's value."
    )
    actTool(
      "browser_select",
      "select",
      { value: { type: "string" } },
      ["ref", "value"],
      "Select an option value on the ref'd control."
    )
    actTool("browser_hover", "hover", {}, ["ref"], "Hover the ref'd element.")

    reg({
      name: "browser_read_console",
      pluginId: ctx.pluginId,
      definition: {
        name: "browser_read_console",
        description: "Drain buffered console messages from the preview.",
        parametersSchema: { type: "object", properties: {} },
      },
      execute: async () => ({ entries: await engineFor().engine.readConsole() }),
    })

    reg({
      name: "browser_read_network",
      pluginId: ctx.pluginId,
      definition: {
        name: "browser_read_network",
        description:
          "Drain buffered network requests (status/timing; not bodies) from the preview.",
        parametersSchema: { type: "object", properties: {} },
      },
      execute: async () => ({ entries: await engineFor().engine.readNetwork() }),
    })

    reg({
      name: "browser_get_page",
      pluginId: ctx.pluginId,
      definition: {
        name: "browser_get_page",
        description: "Return the preview's current url + title.",
        parametersSchema: { type: "object", properties: {} },
      },
      execute: async () => engineFor().engine.getPage(),
    })
  },
  deactivate: async () => {
    // Tools are unregistered automatically by the runtime.
  },
}

export default definition
