/**
 * Offline eval harness for cognia-web-tools.
 *
 * Drives the REAL plugin entry (`src/index.ts`): `pnpm plugin:eval` runs under
 * tsx, which loads the TypeScript module and its `@cognia/plugin-sdk` imports
 * directly. Only the host is faked — `ctx.network.download`,
 * `ctx.agent.invokeTool("web_fetch")` and `ctx.agent.runStreamed` answer from
 * the fixtures below, deterministically and without network — so the offline
 * cases check the plugin's own argument handling (filename / directory
 * sanitising, URL limits, result envelopes) rather than a copy of it.
 *
 * Model tool-SELECTION is not covered offline; that needs the in-app dispatch
 * path (`--online`).
 */

import * as entry from "./src/index.ts"

// tsx may hand the TypeScript module back through CommonJS interop, where the
// default export sits one level deeper.
const plugin = typeof entry.default?.activate === "function" ? entry.default : entry.default.default

const DOWNLOAD_FIXTURES = {
  "https://example.com/report.pdf": 2048,
  "https://example.com/a.zip": 4096,
  "https://evil.test/x": 64,
  "https://example.com/f.bin": 16,
}

const PAGE_FIXTURES = {
  "https://example.com":
    "Example Domain\n\nThis domain is for use in illustrative examples in documents.",
}

/** A deterministic stand-in for a streamed, structured summarization run. */
function fixtureRun(prompt) {
  const sources = Object.keys(PAGE_FIXTURES).filter((url) => prompt.includes(url))
  const object = {
    summary: `Deterministic fixture summary over ${sources.length} source(s).`,
    sources: sources.map((url) => ({ url, title: url })),
  }
  const result = {
    channel: "text",
    toolsAvailable: false,
    text: JSON.stringify(object),
    object,
    parseError: null,
  }
  return {
    agentId: "fixture-run",
    result: Promise.resolve(result),
    cancel() {},
    async *[Symbol.asyncIterator]() {
      yield { type: "text-delta", delta: result.text }
    },
  }
}

const noop = () => {}

function fixtureContext(tools) {
  return {
    pluginId: plugin.manifest.id,
    config: {},
    logger: { debug: noop, info: noop, warn: noop, error: noop },
    capabilities: { tauri: true, mobile: false, web: false, browser: true, platform: "desktop" },
    network: {
      async download(url, destPath) {
        const size = DOWNLOAD_FIXTURES[url]
        if (size === undefined) throw new Error("network:download: HTTP 404")
        return { path: destPath, size }
      },
    },
    agent: {
      context: { registerProvider: () => noop },
      registerTool(tool) {
        tools.set(tool.name, tool)
        return noop
      },
      async invokeTool(name, args) {
        if (name !== "web_fetch") throw new Error(`fixture host has no tool ${name}`)
        const text = PAGE_FIXTURES[args.url]
        return text === undefined
          ? { ok: false, error: "HTTP 404" }
          : { ok: true, status: 200, text }
      },
      runStreamed: fixtureRun,
    },
  }
}

let toolsPromise

async function activatedTools() {
  toolsPromise ??= (async () => {
    const tools = new Map()
    await plugin.activate(fixtureContext(tools))
    return tools
  })()
  return toolsPromise
}

/**
 * @param {string} name tool name as registered by the plugin
 * @param {Record<string, unknown>} args
 * @returns {Promise<unknown>}
 */
export async function invokeTool(name, args) {
  const tool = (await activatedTools()).get(name)
  if (!tool) throw new Error(`unknown tool: ${name}`)
  return tool.execute(args, { config: {} })
}
