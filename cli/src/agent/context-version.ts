/**
 * Stable fingerprint of everything an external protocol bakes into its session.
 *
 * ACP/Codex `session/new` consumes instructions, roots, model, permission mode
 * and the MCP/tool surface ONCE, at session creation. The built-in sidecar has
 * no equivalent problem — it re-reads resolved `SendOptions` on every send — so
 * without a fingerprint an external session silently keeps running under stale
 * instructions after `/mode`, `/skill`, `/mcp`, `/add-dir` or a system-prompt
 * edit, while the TUI shows the new value as active.
 *
 * The hash deliberately covers only SEMANTIC fields. Credentials, per-turn
 * content and transport-local knobs are excluded: including them would recreate
 * the agent's conversation for changes that do not alter what the session means.
 */

import { createHash } from "node:crypto"

import type { McpServer, SendOptions } from "@cognia/agent-config-types"

export interface ContextVersionInput {
  sendOptions: SendOptions
  cwd: string
  additionalDirectories: string[]
  mcpServers: McpServer[]
}

/**
 * Field separator for composite fingerprints. A control character rather than
 * punctuation so a server name, command or argument can never contain it and
 * make two different rows fingerprint alike.
 */
const FIELD_SEP = String.fromCharCode(31)

/** A comparable, credential-free summary of one MCP row. */
function mcpFingerprint(server: McpServer): string {
  const s = server as McpServer & {
    command?: string
    args?: string[]
    url?: string
    transport?: string
  }
  return [
    s.name,
    s.enabled === false ? "off" : "on",
    s.transport ?? "",
    s.command ?? "",
    (s.args ?? []).join(" "),
    s.url ?? "",
  ].join(FIELD_SEP)
}

/** Enabled built-in tool categories, sorted — the toggles that gate discovery. */
function enabledCategories(options: SendOptions): string[] {
  const builtins = options.builtinTools as Record<string, unknown> | undefined
  if (!builtins) return []
  return Object.entries(builtins)
    .filter(([, on]) => on === true)
    .map(([id]) => id)
    .sort()
}

/**
 * The projection that is actually hashed. Exported so a diagnostics surface
 * (`/doctor`) can show WHICH field changed rather than an opaque digest.
 */
export function contextVersionProjection(input: ContextVersionInput): Record<string, unknown> {
  const o = input.sendOptions
  return {
    systemPrompt: o.systemPrompt ?? "",
    model: o.model ?? "",
    provider: o.provider ?? "",
    permissionMode: o.permissionMode ?? "",
    allowedTools: [...(o.allowedTools ?? [])].sort(),
    disallowedTools: [...(o.disallowedTools ?? [])].sort(),
    builtinCategories: enabledCategories(o),
    pluginTools: (o.pluginTools ?? []).map((t) => t.name).sort(),
    confinement: o.confinement
      ? { enabled: o.confinement.enabled, roots: [...o.confinement.roots].sort() }
      : null,
    cwd: input.cwd,
    additionalDirectories: [...input.additionalDirectories].sort(),
    mcpServers: input.mcpServers.map(mcpFingerprint).sort(),
  }
}

/** Hash the projection into a short, comparable context version. */
export function hashContextVersion(input: ContextVersionInput): string {
  const json = JSON.stringify(contextVersionProjection(input))
  return createHash("sha256").update(json).digest("hex").slice(0, 16)
}
