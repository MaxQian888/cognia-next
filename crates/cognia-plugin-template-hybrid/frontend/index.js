"use strict"

const manifest = {
  id: "cognia-plugin-template-hybrid",
  name: "Cognia Plugin Template Hybrid",
  version: "0.1.0",
  type: "hybrid",
  capabilities: ["tools", "python"],
  main: "frontend/index.js",
  pythonMain: "backend/main.py",
  styles: "styles.css",
}

async function activate(ctx) {
  ctx?.logger?.info?.("hybrid template frontend activated")
  return {
    onEvent: async (event) => {
      ctx?.logger?.debug?.("hybrid template frontend event", { type: event?.type })
    },
  }
}

async function deactivate(ctx) {
  ctx?.logger?.info?.("hybrid template frontend deactivated")
}

module.exports = { manifest, activate, deactivate }
