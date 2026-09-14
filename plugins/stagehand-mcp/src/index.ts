/**
 * Stagehand MCP plugin — contributes two Browserbase Stagehand presets to
 * cognia-next's MCP gallery and a `/stagehand` setup guide that compares
 * them:
 *
 *  - `stagehand-hosted` — Browserbase's hosted Streamable-HTTP endpoint
 *    (`https://mcp.browserbase.com/mcp`). The path upstream recommends: no
 *    local Node.js, and the default Gemini model cost is covered — the only
 *    credential is the API key, sent as an `x-bb-api-key` header so the
 *    host's credential vault can externalize it (upstream's
 *    `?browserbaseApiKey=` query-param auth is a deprecated fallback whose
 *    param name escapes the vault's SENSITIVE_QUERY match).
 *  - `stagehand` — self-hosted stdio spawn of `@browserbasehq/mcp` via npx.
 *    Full CLI flag control (--modelName, --proxies, --keepAlive, …) at the
 *    cost of a Node.js toolchain and three credentials (Browserbase API key,
 *    project ID, and a model key — Gemini by default).
 *
 * Both presets are materialized in plugin.json (pure data — visible to
 * static tooling before activation, and the packaged manifest is the
 * install-time source of truth). The `defineMcpServerPreset` copies here
 * exist for compile-time checking and the imperative registration call;
 * the parity test in index.test.ts pins them identical.
 *
 * The `/stagehand` command opens the setup modal (`ctx.modal.openModal`)
 * which deep-links into Settings → MCP Servers via the panel's `?preset=`
 * param.
 *
 * Part of M3 of the plugin-first Computer Use plan.
 */

import type { PluginContext, PluginDefinition } from "@cognia/plugin-sdk"
import { defineMcpServerPreset, definePluginManifest } from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"
import { I18N_MESSAGES } from "./i18n"
import { handleStagehandCommand } from "./commands"
import { setPluginShell } from "./runtime"

const STAGEHAND_HOSTED_PRESET = defineMcpServerPreset({
  id: "stagehand-hosted",
  name: "Stagehand — Hosted",
  description:
    "Browserbase's hosted Streamable-HTTP endpoint — no local Node.js, and the default Gemini model cost is covered. The API key goes in a request header so it is stored in the credential vault.",
  icon: "☁️",
  transport: "http",
  config: {
    url: "https://mcp.browserbase.com/mcp",
    headers: {},
  },
  fields: [
    {
      key: "url",
      label: "Endpoint URL",
      placement: "url",
      placeholder: "https://mcp.browserbase.com/mcp",
      description:
        "Leave as-is for the default Gemini model. Optional query params: ?modelName=…&modelApiKey=…&keepAlive=true&proxies=true.",
    },
    {
      // Upstream's preferred hosted auth is `Authorization: Bearer` or
      // `x-bb-api-key`; the raw-key header wins here because the key name
      // matches the vault's SENSITIVE_NAME list (unlike the deprecated
      // `browserbaseApiKey` query param, which would persist in plaintext)
      // and the user pastes the key verbatim — no Bearer prefix to fumble.
      key: "x-bb-api-key",
      label: "Browserbase API key",
      placement: "header",
      placeholder: "bb_live_…",
      secret: true,
      description: "Get one at browserbase.com/overview.",
    },
  ],
  runtime: "both",
  docsUrl: "https://docs.browserbase.com/integrations/mcp/setup",
  tags: ["web", "browser", "ai-native", "cloud"],
})

const STAGEHAND_PRESET = defineMcpServerPreset({
  id: "stagehand",
  name: "Stagehand — Self-hosted",
  description:
    "AI-native browser automation (act / extract / observe / agent). Spawns @browserbasehq/mcp over stdio; sessions run on Browserbase cloud Chromium.",
  // 🖥️ not 🎭 — the static `playwright` preset already owns the theatre mask
  // in the same gallery, and a shared icon reads as a duplicate card.
  icon: "🖥️",
  transport: "stdio",
  config: {
    // Upstream moved twice: `@browserbasehq/mcp-stagehand` (what this preset
    // used to point at) is a hard npm 404, and its successor
    // `@browserbasehq/mcp-server-browserbase` is deprecated in favour of
    // `@browserbasehq/mcp`. The old name made `npx` fail at spawn every time.
    command: "npx",
    args: ["-y", "@browserbasehq/mcp@latest"],
    env: { BROWSERBASE_API_KEY: "", BROWSERBASE_PROJECT_ID: "", GEMINI_API_KEY: "" },
  },
  fields: [
    {
      key: "BROWSERBASE_API_KEY",
      label: "Browserbase API key",
      placement: "env",
      secret: true,
      description: "Get one at browserbase.com.",
    },
    {
      key: "BROWSERBASE_PROJECT_ID",
      label: "Browserbase project ID",
      placement: "env",
    },
    {
      key: "GEMINI_API_KEY",
      label: "Gemini API key (Stagehand model)",
      placement: "env",
      secret: true,
      description:
        "Stagehand defaults to google/gemini-2.5-flash-lite. Pass --modelName plus --modelApiKey in the server args to use a different provider.",
    },
  ],
  runtime: "both",
  docsUrl: "https://github.com/browserbase/mcp-server-browserbase",
  tags: ["web", "browser", "ai-native"],
})

const STAGEHAND_PRESETS = [STAGEHAND_HOSTED_PRESET, STAGEHAND_PRESET]

const definition: PluginDefinition = {
  // Spread plugin.json: `builtinManifest()` merges module-over-JSON, so a
  // hand-written subset here would WIN and silently drop `commands[]`.
  manifest: definePluginManifest({
    ...manifestJson,
    mcpServerPresets: STAGEHAND_PRESETS,
    i18n: { locales: I18N_MESSAGES },
  }),
  activate: async (ctx: PluginContext) => {
    ctx.logger?.info("stagehand-mcp plugin activated")

    // The setup modal's environment check reaches `ctx.shell` through this
    // slot — modal components only receive PluginModalProps. Cleared via
    // the generation lifecycle so a re-activation can't leak a stale API.
    setPluginShell(ctx.shell)
    ctx.lifecycle?.onDispose(() => setPluginShell(undefined), "stagehand-mcp:shell")

    // The manifest-driven registration already happens in
    // PluginManager.registerPluginContributions (M1·T5). The imperative
    // call here is a no-op idempotency belt-and-suspenders for users who
    // load the plugin via the dynamic ctx.agent path rather than through
    // the manifest reader.
    for (const preset of STAGEHAND_PRESETS) {
      ctx.agent?.registerMcpServerPreset?.(preset)
    }

    // The slash command is DECLARED in plugin.json (`commands[]`) and handled
    // here — the supported shape per the author-SDK migration table. The
    // manager owns registration (namespaced id, conflict detection, aliases,
    // command-palette entry, idle-clock refresh) and teardown.
    return {
      onCommand: async (command: string, args: string[]) =>
        handleStagehandCommand(ctx, command, args) ?? false,
    }
  },
}

export default definition
