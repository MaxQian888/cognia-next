"use strict"

/**
 * Cognia hybrid plugin template, frontend half.
 *
 * A hybrid plugin is two runtimes with one manifest. The Python half in
 * `backend/main.py` owns the work, and this half owns everything Python cannot
 * reach: the agent tool registry, slash commands, toasts, and durable storage.
 *
 * The bridge is `ctx.python`, which is present on the context for `hybrid` and
 * `python` plugins and absent for `frontend` ones. `ctx.python.call(name, ...)`
 * invokes a module-level public callable in `pythonMain`, so a plain function
 * over there is a callable from over here without any extra registration.
 */

const manifest = {
  id: "cognia-plugin-template-hybrid",
  name: "Cognia Plugin Template Hybrid",
  version: "0.1.0",
  type: "hybrid",
  capabilities: ["tools", "python", "commands"],
  main: "frontend/index.js",
  pythonMain: "backend/main.py",
  styles: "styles.css",
}

async function activate(ctx) {
  ctx.logger.info("hybrid template frontend activated")

  // Registered from JavaScript, computed in Python. The agent sees one tool and
  // does not care which runtime answered it.
  const disposeTool = ctx.agent.registerTool({
    name: "template_word_count",
    pluginId: ctx.pluginId,
    definition: {
      name: "template_word_count",
      description: "Count words in a string.",
      parametersSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to count words in." },
        },
        required: ["text"],
        additionalProperties: false,
      },
    },
    execute: async (args) => {
      const text = typeof args?.text === "string" ? args.text : ""
      const words = await ctx.python.call("word_count", text)
      return { ok: true, words }
    },
  })

  // The ledger tears this down when the activation generation ends, which a
  // module-scope variable would not survive a reload of.
  ctx.lifecycle.onDispose(disposeTool, "tool:template_word_count")

  return {
    onCommand: async (command, args) => {
      if (command !== "template-wordcount") return false
      const text = args.join(" ")
      const words = await ctx.python.call("word_count", text)
      ctx.ui.showToast(`${words} word(s)`, "info")
      return { handled: true, message: `\`${text}\` is **${words}** word(s).` }
    },

    onEvent: async (event) => {
      ctx.logger.debug("hybrid template frontend event", { type: event?.type })
    },
  }
}

async function deactivate(ctx) {
  ctx?.logger?.info?.("hybrid template frontend deactivated")
}

module.exports = { manifest, activate, deactivate }
