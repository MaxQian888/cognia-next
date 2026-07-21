/**
 * Read an agent's MCP config and turn one entry into a
 * `PluginMcpServerPresetDef`.
 *
 * Parsing is delegated wholesale to the adapters in `lib/claude/agents/*`
 * — thirteen of them already know each agent's quirks (VS Code's `servers`
 * key, Windsurf's `serverUrl`, Gemini's `httpUrl`/`url` split, Roo Code's
 * `streamable-http`). Re-deriving any of that here would be a second
 * implementation to keep in sync, so the converter picks an adapter and
 * calls `parse()`.
 *
 * TOML-backed agents (Codex) are out of scope: their adapters consume an
 * already-decoded TOML tree, and pulling a TOML parser into the bundled
 * converter buys one agent. The error names the limitation instead of
 * silently returning nothing.
 */

import { MCP_AGENT_ADAPTERS, type McpAgentAdapter } from "@/lib/claude/agents"
import type { PluginMcpServerPresetDef } from "@/types/plugin/plugin-mcp-preset"
import type { McpImportDraft } from "@/lib/db/mcp-servers"
import { sanitizeMcpConfig } from "./secrets"
import type { ConvertCandidate } from "./types"

/** Adapters the converter can drive (JSON / JSONC only — see module note). */
export const SUPPORTED_MCP_ADAPTERS: McpAgentAdapter[] = MCP_AGENT_ADAPTERS.filter(
  (adapter) => adapter.format !== "toml"
)

/** Strip `//` and `/* *\/` comments plus trailing commas from JSONC text. */
export function stripJsonComments(text: string): string {
  let out = ""
  let inString = false
  let inLine = false
  let inBlock = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    const next = text[i + 1]
    if (inLine) {
      if (ch === "\n") {
        inLine = false
        out += ch
      }
      continue
    }
    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false
        i += 1
      }
      continue
    }
    if (inString) {
      out += ch
      if (ch === "\\") {
        out += next ?? ""
        i += 1
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === "/" && next === "/") {
      inLine = true
      i += 1
      continue
    }
    if (ch === "/" && next === "*") {
      inBlock = true
      i += 1
      continue
    }
    out += ch
  }
  // Trailing commas are legal in JSONC but not JSON.
  return out.replace(/,(\s*[}\]])/g, "$1")
}

/**
 * Choose the adapter for a config file.
 *
 * The filename is the strongest signal (`~/.cursor/mcp.json`,
 * `claude_desktop_config.json`, `settings.json`); when it is
 * uninformative, fall back to whichever adapter actually finds entries.
 * Ties go to the earliest adapter in the registry, which is ordered by
 * how canonical each agent's format is.
 */
export function selectMcpAdapter(sourceName: string | undefined, value: unknown): McpAgentAdapter {
  const lower = (sourceName ?? "").toLowerCase()
  const byName = SUPPORTED_MCP_ADAPTERS.find((adapter) => lower.includes(adapter.id))
  if (byName && byName.parse(value).length > 0) return byName

  const productive = SUPPORTED_MCP_ADAPTERS.find((adapter) => adapter.parse(value).length > 0)
  if (productive) return productive

  throw new Error(
    "no MCP servers found in this file — expected a config with an `mcpServers` (or `servers`) object"
  )
}

/** Parse a config file's text into the adapter's normalized drafts. */
export function readMcpDrafts(
  text: string,
  sourceName?: string
): { adapter: McpAgentAdapter; drafts: McpImportDraft[] } {
  let value: unknown
  try {
    value = JSON.parse(stripJsonComments(text))
  } catch (err) {
    throw new Error(
      `could not parse "${sourceName ?? "input"}" as JSON/JSONC: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  const adapter = selectMcpAdapter(sourceName, value)
  return { adapter, drafts: adapter.parse(value) }
}

/** List the server entries the author can `--pick`. */
export function listMcpCandidates(text: string, sourceName?: string): ConvertCandidate[] {
  const { drafts } = readMcpDrafts(text, sourceName)
  return drafts.map((draft) => ({
    id: draft.name,
    label: draft.name,
    detail:
      draft.transport === "stdio"
        ? `stdio · ${String(draft.config.command ?? "")}`
        : `${draft.transport} · ${String(draft.config.url ?? "")}`,
  }))
}

/** One picked server, converted into a shippable preset. */
export interface BuiltMcpPreset {
  preset: PluginMcpServerPresetDef
  draft: McpImportDraft
  todos: string[]
}

/**
 * Build the preset for `pick`.
 *
 * `runtime` is left unset (the default is `"both"`): nothing in an agent
 * config says a server only works under one of cognia's two agent
 * runtimes, and guessing would silently hide the preset from one of them.
 */
export function buildMcpPreset(text: string, pick: string, sourceName?: string): BuiltMcpPreset {
  const { drafts } = readMcpDrafts(text, sourceName)
  const draft = drafts.find((d) => d.name === pick)
  if (!draft) {
    const available = drafts.map((d) => d.name).join(", ") || "(none)"
    throw new Error(`no MCP server named "${pick}" in this file — available: ${available}`)
  }

  const { config, fields, todos } = sanitizeMcpConfig(draft.transport, draft.config)
  const preset: PluginMcpServerPresetDef = {
    id: draft.name,
    name: draft.name,
    // Built from the SANITIZED config, never the source one: the raw
    // invocation embeds the very absolute paths and URLs that sanitization
    // just replaced, and the description is copied into plugin.json,
    // package.json, and README.md.
    description: describeConfig(draft.transport, config),
    transport: draft.transport,
    config,
    fields,
  }
  return { preset, draft, todos }
}

/**
 * A one-line description built only from what the sanitized config states.
 * The converter never spawns the server, so it cannot enumerate the
 * server's tools — claiming otherwise would be fiction.
 */
export function describeConfig(
  transport: McpImportDraft["transport"],
  config: Record<string, unknown>
): string {
  if (transport === "stdio") {
    const command = String(config.command ?? "").trim()
    const args = Array.isArray(config.args)
      ? config.args.filter((a): a is string => typeof a === "string")
      : []
    const invocation = [command, ...args].filter(Boolean).join(" ")
    return `MCP server run locally via \`${invocation}\`.`
  }
  const url = String(config.url ?? "").trim()
  return url
    ? `Remote ${transport.toUpperCase()} MCP server at ${url}.`
    : `Remote ${transport.toUpperCase()} MCP server.`
}
