/**
 * MCP server presets contributed by the plugin.
 *
 * These populate the "Add server" gallery alongside the static `MCP_PRESETS`
 * (same `config` shape: stdio → { command, args, env }; `fields` let the user
 * fill secrets / arg tokens). The host can't bundle the actual executables, so
 * the user installs them once (the SetupCheck panel guides this); the plugin
 * only ships the presets, all `npx`/`uvx`-spawnable.
 *
 * zget is deliberately NOT an MCP preset: it has no native MCP server, and a
 * built-in plugin's `ctx.pluginPath` is a `builtin://` URL (not a disk path),
 * so a bundled-wrapper preset couldn't be spawned. Instead the chat roles run
 * `zget … --format json` via their Bash tool, and the front workflow runs it
 * via the built-in `action.system.terminal` node — both real-shell paths that
 * work for a built-in plugin.
 */

import { defineMcpServerPreset } from "@cognia/plugin-sdk"
import type { PluginMcpServerPresetDef } from "@cognia/plugin-sdk"
import { mcpPresetId } from "../ids"

/** Exa — web search & fetch (research backbone). */
export const EXA_PRESET = defineMcpServerPreset({
  id: mcpPresetId("exa"),
  name: "Exa (知乎调研)",
  description: "联网搜索与网页抓取，调研主力。需要 EXA_API_KEY。",
  icon: "🔎",
  transport: "stdio",
  config: {
    command: "npx",
    args: ["-y", "exa-mcp-server"],
    env: { EXA_API_KEY: "" },
  },
  fields: [
    {
      key: "EXA_API_KEY",
      label: "Exa API Key",
      placement: "env",
      secret: true,
      description: "从 exa.ai 获取。",
    },
  ],
  docsUrl: "https://github.com/exa-labs/exa-mcp-server",
  tags: ["web", "search", "research"],
})

/** Fetch — pull a known URL to Markdown. */
export const FETCH_PRESET = defineMcpServerPreset({
  id: mcpPresetId("fetch"),
  name: "Fetch (抓网页)",
  description: "抓取指定 URL 并转 Markdown。",
  icon: "🌐",
  transport: "stdio",
  config: {
    command: "uvx",
    args: ["mcp-server-fetch"],
  },
  fields: [],
  docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
  tags: ["web", "fetch"],
})

/** Sequential Thinking — structured multi-step reasoning for the writer. */
export const SEQUENTIAL_THINKING_PRESET = defineMcpServerPreset({
  id: mcpPresetId("sequential-thinking"),
  name: "Sequential Thinking",
  description: "结构化多步推理，给写手理顺长文论证。",
  icon: "🧠",
  transport: "stdio",
  config: {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
  },
  fields: [],
  docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking",
  tags: ["reasoning"],
})

/**
 * CloakBrowser — human-like stealth browser via the official Playwright MCP
 * pointed at a `cloakserve` CDP endpoint. The user runs `cloakserve` (from
 * `pip install cloakbrowser`) and pastes its CDP URL; the agent then gets the
 * standard Playwright MCP tool surface backed by a stealth + humanized browser.
 */
export const CLOAK_BROWSER_PRESET = defineMcpServerPreset({
  id: mcpPresetId("cloak-browser"),
  name: "CloakBrowser (拟人浏览器)",
  description:
    "经 Playwright MCP 连到 CloakBrowser 的 cloakserve CDP，拟人化隐身浏览，抓登录/反爬页面。",
  icon: "🥷",
  transport: "stdio",
  config: {
    command: "npx",
    args: ["-y", "@playwright/mcp@latest", "--cdp-endpoint", "<CDP_ENDPOINT>"],
  },
  fields: [
    {
      key: "CDP_ENDPOINT",
      label: "cloakserve CDP 地址",
      placement: "arg-replace",
      token: "<CDP_ENDPOINT>",
      placeholder: "http://127.0.0.1:9222",
      description: "运行 `cloakserve` 后它打印的 CDP endpoint。",
    },
  ],
  docsUrl: "https://github.com/CloakHQ/CloakBrowser",
  tags: ["browser", "stealth", "scraping"],
})

/** Static presets that ride the declarative manifest (all `npx`/`uvx`-spawnable). */
export const STATIC_MCP_PRESETS: PluginMcpServerPresetDef[] = [
  EXA_PRESET,
  FETCH_PRESET,
  SEQUENTIAL_THINKING_PRESET,
  CLOAK_BROWSER_PRESET,
]
