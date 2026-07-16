// opencode. Global config at ~/.config/opencode/opencode.json, MCP servers
// under the `mcp` key. This adapter can't lean on the shared normalize helpers
// because opencode's shape differs from every other agent we sync:
//   1. `type` is "local" | "remote" — not "stdio" | "http" | "sse".
//   2. `command` is a single ARRAY with the executable and its args flattened
//      together (["npx", "-y", "pkg"]), not command + args.
//   3. Env vars live under `environment`, not `env`.
//   4. Remote servers use `url` + optional `headers`.
// Verified against a real ~/.config/opencode/opencode.json and
// https://opencode.ai/docs/mcp-servers/

import type { McpServer } from "@cognia/agent-config-types"
import type { McpImportDraft } from "@/lib/db/mcp-servers"
import type { McpAgentAdapter } from "./index"
import { dropInvalidDrafts } from "./shared"

interface RawOpencodeConfig {
  mcp?: Record<string, unknown>
  [key: string]: unknown
}

function asRoot(value: unknown): RawOpencodeConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as RawOpencodeConfig
}

function parse(value: unknown): McpImportDraft[] {
  const root = asRoot(value)
  if (!root?.mcp || typeof root.mcp !== "object") return []
  const out: McpImportDraft[] = []

  for (const [name, raw] of Object.entries(root.mcp)) {
    if (!raw || typeof raw !== "object") continue
    const entry = raw as Record<string, unknown>

    if (entry.type === "remote" || typeof entry.url === "string") {
      if (typeof entry.url !== "string") continue
      const config: Record<string, unknown> = { url: entry.url }
      if (entry.headers && typeof entry.headers === "object") config.headers = entry.headers
      out.push({ name, transport: "http", config })
      continue
    }

    // Local: split the flattened command array back into command + args.
    const command = entry.command
    if (!Array.isArray(command) || command.length === 0) continue
    const [bin, ...args] = command.filter((c): c is string => typeof c === "string")
    if (!bin) continue
    const config: Record<string, unknown> = { command: bin }
    if (args.length > 0) config.args = args
    if (entry.environment && typeof entry.environment === "object") {
      config.env = entry.environment
    }
    out.push({ name, transport: "stdio", config })
  }

  return dropInvalidDrafts(out)
}

function project(
  existing: unknown | null,
  servers: McpServer[],
  managedNames?: ReadonlySet<string>
): unknown {
  const root: RawOpencodeConfig = asRoot(existing) ?? {}
  const managedSet = managedNames ?? new Set(servers.map((s) => s.name))
  const next: Record<string, unknown> = {}

  if (root.mcp && typeof root.mcp === "object") {
    for (const [name, value] of Object.entries(root.mcp)) {
      if (!managedSet.has(name)) next[name] = value
    }
  }

  for (const server of servers) {
    const config = server.config as Record<string, unknown>
    const enabled = server.enabled !== false

    if (server.transport === "stdio") {
      const bin = typeof config.command === "string" ? config.command : ""
      const args = Array.isArray(config.args)
        ? config.args.filter((a): a is string => typeof a === "string")
        : []
      const entry: Record<string, unknown> = {
        type: "local",
        command: [bin, ...args],
        enabled,
      }
      const env = config.env
      if (env && typeof env === "object" && Object.keys(env).length > 0) {
        entry.environment = env
      }
      next[server.name] = entry
      continue
    }

    // opencode has a single `remote` kind covering http and sse.
    const entry: Record<string, unknown> = {
      type: "remote",
      url: typeof config.url === "string" ? config.url : "",
      enabled,
    }
    const headers = config.headers
    if (headers && typeof headers === "object" && Object.keys(headers).length > 0) {
      entry.headers = headers
    }
    next[server.name] = entry
  }

  return { ...root, mcp: next }
}

export const OPENCODE_AGENT: McpAgentAdapter = {
  id: "opencode",
  displayName: "opencode",
  description: "~/.config/opencode/opencode.json — `mcp` key, command is one array",
  writable: true,
  format: "json",
  parse,
  project,
}
