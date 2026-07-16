// Zed. MCP servers live under `context_servers` in Zed's settings.json
// (macOS/Linux ~/.config/zed/settings.json, Windows %APPDATA%/Zed/settings.json).
// Quirks, all verified against zed-industries/zed
// crates/settings_content/src/project.rs (ContextServerSettingsContent):
//   1. The entry enum is `#[serde(untagged)]` — there is NO `type` or `source`
//      discriminator. Zed picks the variant structurally: `command` => stdio,
//      `url` => http, `settings` => extension-provided. Older Zed docs still
//      show `"source": "custom"`; current Zed does not use it.
//   2. `command` is a plain string (ContextServerCommand#path, renamed), with
//      `args` / `env` flattened alongside it — not a nested object.
//   3. Extension-provided servers (`settings`, no command/url) are owned by the
//      extension. We can't represent them, so we skip them on parse and leave
//      them untouched on project.
//   4. settings.json is JSONC — comments are stripped on write, same caveat as
//      VS Code.
//   5. Zed's http variant covers streamable HTTP only; an SSE server projects
//      to the same `url` shape.

import type { McpServer } from "@cognia/agent-config-types"
import type { McpImportDraft } from "@/lib/db/mcp-servers"
import type { McpAgentAdapter } from "./index"
import { denormalizeMcpEntry, dropInvalidDrafts, normalizeMcpEntry } from "./shared"

/** Zed-only lifecycle keys — stripped on parse so they can't leak cross-agent. */
const ZED_ONLY_KEYS = ["enabled", "remote"] as const

interface RawZedConfig {
  context_servers?: Record<string, unknown>
  [key: string]: unknown
}

function asRoot(value: unknown): RawZedConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as RawZedConfig
}

/** True for the Extension variant: has `settings`, no command and no url. */
function isExtensionEntry(entry: Record<string, unknown>): boolean {
  return "settings" in entry && !("command" in entry) && !("url" in entry)
}

function parse(value: unknown): McpImportDraft[] {
  const root = asRoot(value)
  if (!root?.context_servers || typeof root.context_servers !== "object") return []
  const out: McpImportDraft[] = []
  for (const [name, raw] of Object.entries(root.context_servers)) {
    if (!raw || typeof raw !== "object") continue
    const entry = { ...(raw as Record<string, unknown>) }
    if (isExtensionEntry(entry)) continue
    for (const key of ZED_ONLY_KEYS) delete entry[key]
    const norm = normalizeMcpEntry(entry)
    if (!norm) continue
    out.push({ name, transport: norm.transport, config: norm.config })
  }
  return dropInvalidDrafts(out)
}

function project(
  existing: unknown | null,
  servers: McpServer[],
  managedNames?: ReadonlySet<string>
): unknown {
  const root: RawZedConfig = asRoot(existing) ?? {}
  const managedSet = managedNames ?? new Set(servers.map((s) => s.name))
  const next: Record<string, unknown> = {}

  if (root.context_servers && typeof root.context_servers === "object") {
    for (const [name, value] of Object.entries(root.context_servers)) {
      // Never claim an extension-provided server, even if the name collides —
      // rewriting it as a custom entry would break the extension's own server.
      const isExtension =
        !!value && typeof value === "object" && isExtensionEntry(value as Record<string, unknown>)
      if (!managedSet.has(name) || isExtension) next[name] = value
    }
  }

  for (const server of servers) {
    if (next[server.name] !== undefined) continue
    next[server.name] = {
      // Zed has a first-class `enabled` flag, so honour the server's own
      // toggle instead of projecting a disabled server as live.
      enabled: server.enabled !== false,
      ...denormalizeMcpEntry(server.transport, server.config, { typeKey: null }),
    }
  }

  return { ...root, context_servers: next }
}

export const ZED_AGENT: McpAgentAdapter = {
  id: "zed",
  displayName: "Zed",
  description: "settings.json `context_servers` — no `type` key, JSONC",
  writable: true,
  format: "jsonc",
  parse,
  project,
}
