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

// Last known preview URL — a fallback for when the live URL is unreadable
// (preview not open yet / document mid-swap).
let lastUrl = "http://localhost:3000/"

function engineFor() {
  return routeEngine(lastUrl)
}

/**
 * Resolve the route from the page's LIVE URL, not the last URL the model asked
 * for — the page may have redirected (or the human navigated) to a different
 * origin since, and the trust tier must follow the actual content.
 */
async function currentRoute() {
  const { engine } = engineFor()
  try {
    const { url } = await engine.getPage()
    if (url) lastUrl = url
  } catch {
    // Preview not open / mid-navigation: fall back to the last known URL.
  }
  return routeEngine(lastUrl)
}

async function withSnapshot(result: Record<string, unknown>, initialDelayMs?: number) {
  const engine = engineFor().engine
  // A mutating action may have triggered a navigation (link click, form
  // submit): settle until the document is loaded so the snapshot reflects the
  // page the action produced, not the one it left. No-op on a settled page.
  // `initialDelayMs` gives same-URL loads (reload/back/forward) time to start
  // before the readyState check can pass on the OLD document.
  await engine.waitForLoad({ timeoutMs: 3000, initialDelayMs })
  const snapshot = await engine.snapshot()
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
          'Browser tools drive the in-app preview webview (best for localhost / your own dev server): browser_navigate (+ browser_back/forward/reload/stop), browser_snapshot (a11y tree with refs; pass includeText:true to also read headings/paragraphs; shadow-DOM and same-origin iframe nodes are included), browser_click (optional modifiers:["ctrl","shift"])/type/fill_form/select/hover (target by ref), browser_press_key (Enter/Tab/Escape/Arrow*/ctrl+a — for shortcuts & navigation; use browser_type for text), browser_scroll (by ref or page direction), browser_evaluate (run a JS expression — trusted localhost only), browser_wait_for (text, a CSS selector, or networkIdle), browser_screenshot (PNG vision fallback), browser_read_console, browser_read_network, browser_get_page. Always take a fresh browser_snapshot after navigation or any mutating action, and act on elements by the `ref` from the latest snapshot. Links with target="_blank" and window.open() land in the same preview (no tabs/popups), and SPA history navigations are tracked. For arbitrary PUBLIC websites the embedded preview is best-effort only (cross-origin iframes are invisible, synthetic events are untrusted, response bodies are unavailable) — prefer the Playwright MCP tools (mcp__playwright__*) for those if the Playwright MCP server is attached.',
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
        const { engine } = engineFor()
        const pre = await engine.getPage().catch(() => null)
        lastUrl = url
        await engine.navigate(url)
        // Wait for the new document (URL change + readyState complete) so the
        // returned snapshot is of the target page, not the one we left.
        await engine.waitForLoad({ targetUrl: url, fromUrl: pre?.url, timeoutMs: 8000 })
        // Trust follows where the page actually landed (redirects included).
        const { untrusted } = await currentRoute()
        const base = { ...(await withSnapshot({ navigated: url })), untrusted }
        // Steer public-site automation to the Playwright MCP tools — the embedded
        // engine is best-effort off-localhost (see the availability context).
        return untrusted
          ? {
              ...base,
              hint: "Public URL: the embedded preview is best-effort here (no cross-origin iframes, untrusted events, no response bodies). For reliable automation prefer the Playwright MCP tools (mcp__playwright__*) if the Playwright MCP server is attached.",
            }
          : base
      },
    })

    reg({
      name: "browser_snapshot",
      pluginId: ctx.pluginId,
      definition: {
        name: "browser_snapshot",
        description:
          "Capture the accessibility-tree snapshot of the preview. Returns ref'd nodes (incl. shadow-DOM and same-origin iframe nodes); prefer this over a screenshot. Pass includeText:true to also surface salient non-interactive text (headings, list items, etc.).",
        parametersSchema: {
          type: "object",
          properties: { includeText: { type: "boolean" } },
        },
      },
      execute: async (args) =>
        engineFor().engine.snapshot({
          includeText: !!(args as { includeText?: boolean })?.includeText,
        }),
    })

    reg({
      name: "browser_press_key",
      pluginId: ctx.pluginId,
      definition: {
        name: "browser_press_key",
        description:
          "Press a key chord on the page: a named key (Enter, Tab, Escape, Backspace, Delete, Home, End, PageUp, PageDown, ArrowUp/Down/Left/Right, F1–F24) or a chord (ctrl+a, shift+Tab, alt+ArrowLeft). Optionally target a ref; default is the focused element. For typing text use browser_type, not this.",
        parametersSchema: {
          type: "object",
          properties: { key: { type: "string" }, ref: { type: "string" } },
          required: ["key"],
        },
      },
      execute: async (args) => {
        const a = (args ?? {}) as { key?: string; ref?: string }
        const result = await engineFor().engine.pressKey(String(a.key ?? ""), a.ref)
        return withSnapshot({ result })
      },
    })

    reg({
      name: "browser_scroll",
      pluginId: ctx.pluginId,
      definition: {
        name: "browser_scroll",
        description:
          "Scroll the preview: pass a `ref` to scroll that element into view, or a page `direction` (up/down/left/right/top/bottom) with an optional pixel `amount`.",
        parametersSchema: {
          type: "object",
          properties: {
            ref: { type: "string" },
            direction: {
              type: "string",
              enum: ["up", "down", "left", "right", "top", "bottom"],
            },
            amount: { type: "number" },
          },
        },
      },
      execute: async (args) => {
        const a = (args ?? {}) as {
          ref?: string
          direction?: "up" | "down" | "left" | "right" | "top" | "bottom"
          amount?: number
        }
        const result = await engineFor().engine.scroll({
          reference: a.ref,
          direction: a.direction,
          amount: a.amount,
        })
        return withSnapshot({ result })
      },
    })

    reg({
      name: "browser_evaluate",
      pluginId: ctx.pluginId,
      definition: {
        name: "browser_evaluate",
        description:
          'Evaluate a JavaScript EXPRESSION in the page and return its JSON value (e.g. "document.title" or "[...document.querySelectorAll(\'a\')].map(a=>a.href)"). Single expression only — no statements. Enabled only on the trusted localhost preview; blocked on public origins.',
        parametersSchema: {
          type: "object",
          properties: { expression: { type: "string" } },
          required: ["expression"],
        },
      },
      execute: async (args) => {
        const expr = String((args as { expression?: string })?.expression ?? "")
        // Gate on the LIVE page URL: a localhost page may have redirected to a
        // public origin since the last navigate.
        const { engine, untrusted } = await currentRoute()
        if (untrusted) {
          return {
            ok: false,
            error:
              "browser_evaluate is disabled on public origins (untrusted page). Use the Playwright MCP tools (mcp__playwright__*) for public sites.",
          }
        }
        return engine.evaluate(expr)
      },
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
          if ("modifiers" in a) callArgs.modifiers = a.modifiers
          const result = await engineFor().engine.act(ref, action, callArgs)
          return withSnapshot({ result })
        },
      })

    actTool(
      "browser_click",
      "click",
      { modifiers: { type: "array", items: { type: "string" } } },
      ["ref"],
      'Click the element with the given ref. Optional `modifiers` (e.g. ["ctrl"], ["shift"]) for modifier-clicks.'
    )
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

    type Engine = ReturnType<typeof engineFor>["engine"]
    const navTool = (
      name: string,
      desc: string,
      run: (engine: Engine) => Promise<void>,
      settleMs = 0
    ) =>
      reg({
        name,
        pluginId: ctx.pluginId,
        definition: {
          name,
          description: desc,
          parametersSchema: { type: "object", properties: {} },
        },
        execute: async () => {
          await run(engineFor().engine)
          return withSnapshot({ ok: true }, settleMs || undefined)
        },
      })

    navTool(
      "browser_back",
      "Go back in the preview's history; returns a fresh snapshot.",
      (e) => e.back(),
      250
    )
    navTool(
      "browser_forward",
      "Go forward in the preview's history; returns a fresh snapshot.",
      (e) => e.forward(),
      250
    )
    navTool(
      "browser_reload",
      "Reload the preview; returns a fresh snapshot.",
      (e) => e.reload(),
      250
    )
    navTool("browser_stop", "Stop the preview's current load.", (e) => e.stop())

    reg({
      name: "browser_wait_for",
      pluginId: ctx.pluginId,
      definition: {
        name: "browser_wait_for",
        description:
          "Wait for a condition, up to `timeoutMs`: visible `text` appears/disappears (default), an element matching a CSS `selector` appears/disappears, or the network goes idle (`networkIdle: true` — no in-flight or new requests). Provide exactly one of text/selector/networkIdle. Returns the wait result plus a fresh snapshot.",
        parametersSchema: {
          type: "object",
          properties: {
            text: { type: "string" },
            selector: { type: "string" },
            networkIdle: { type: "boolean" },
            mode: { type: "string", enum: ["appear", "disappear"] },
            timeoutMs: { type: "number" },
          },
        },
      },
      execute: async (args) => {
        const a = (args ?? {}) as {
          text?: string
          selector?: string
          networkIdle?: boolean
          mode?: "appear" | "disappear"
          timeoutMs?: number
        }
        const engine = engineFor().engine
        let result
        if (a.networkIdle) {
          result = await engine.waitForNetworkIdle({ timeoutMs: a.timeoutMs })
        } else if (a.selector) {
          result = await engine.waitForSelector(a.selector, {
            mode: a.mode,
            timeoutMs: a.timeoutMs,
          })
        } else {
          result = await engine.waitForText(String(a.text ?? ""), {
            mode: a.mode,
            timeoutMs: a.timeoutMs,
          })
        }
        return withSnapshot({ result })
      },
    })

    reg({
      name: "browser_screenshot",
      pluginId: ctx.pluginId,
      definition: {
        name: "browser_screenshot",
        description:
          "Capture a PNG of the current preview (vision fallback — prefer browser_snapshot for structure). Returns base64 PNG bytes.",
        parametersSchema: { type: "object", properties: {} },
      },
      execute: async () => {
        try {
          const shot = await engineFor().engine.screenshot()
          return { ok: true, base64: shot.bytes, width: shot.width, height: shot.height }
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      },
    })

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
