/**
 * A structural summary of the settings an audit must not read as text
 * (ADR-0238 §3).
 *
 * Hooks, MCP servers and permission rules live next to secrets: a hook command
 * line can carry a token, an MCP server an `Authorization` header, an HTTP hook
 * a signed URL. The upstream prompt-audit method refuses to open those files
 * at all, which leaves an audit blind to the very rules it should be checking
 * against ("this prose rule is already a hook", "this prohibition contradicts a
 * permission rule"). The host parses them here instead and returns only what a
 * rule is, never how it runs:
 *
 * - hook handlers: event, matcher, type and a label (an executable's base name,
 *   an HTTP host, an MCP server/tool pair); never arguments, environment,
 *   headers or prompt text;
 * - permission rules: tool, glob and verdict (the patterns are the rule),
 *   with credentials a pattern can hold masked and a row that still leaks
 *   dropped (`sanitizeFactText`);
 * - MCP servers: id, name, transport, enabled; never the configuration.
 */

import { hasNoLeakingPii, redactText } from "@cognia/redact"

import { readClaudeEffectiveSettings, type ClaudeSettings } from "@/lib/claude/settings"
import { resolveInstructionsConfig } from "@/lib/claude/instructions/types"
import { listRules } from "@/lib/claude/permissions/ruleset-edit"
import type { Ruleset, ToolRules } from "@/lib/claude/permissions/ruleset"
import { listMcpServers } from "@/lib/db/mcp-servers"
import { listSkills } from "@/lib/db/skills"
import { isTauri } from "@/lib/tauri"
import { useSettingsStore } from "@/stores/settings"
import type { AgentConfigFacts, AgentConfigHookFact, AgentConfigPermissionFact } from "./types"
import { resolveAgentConfigWorkspace } from "./workspace"

/** Leading `NAME=value` assignments a shell would apply before the command. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/** A label made only of name characters; anything else (a URL query, a quote) is not shown. */
const SAFE_LABEL = /^[\w.+-]+$/

/** The executable a command line runs, as a bare base name. */
export function commandLabel(command: string): string {
  const tokens = command.trim().split(/\s+/)
  let index = 0
  while (index < tokens.length && ENV_ASSIGNMENT.test(tokens[index] ?? "")) index++
  const first = (tokens[index] ?? "").replace(/^["']|["']$/g, "")
  const base = (first.split(/[\\/]/).pop() ?? "").split(/[?#]/)[0] ?? ""
  return base && SAFE_LABEL.test(base) ? base : "command"
}

/**
 * Credentials a rule pattern can carry that the PII detectors do not
 * recognize: Claude Code's "always allow" stores the exact command approved,
 * so `Bash(PGPASSWORD=… psql …)`, `mysql -pX` or `curl -u user:pass` end up
 * as permission patterns.
 */
const RULE_SECRETS: ReadonlyArray<[RegExp, string]> = [
  // `NAME=value` assignments, quoted or not.
  [/\b([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s)]+)/g, "$1=[REDACTED]"],
  // `--password x`, `--token=x`, `--api-key x` and friends.
  [
    /(--?(?:password|passwd|pass|pwd|token|secret|api-?key|auth|credentials?)(?:=|\s+))("[^"]*"|'[^']*'|[^\s)]+)/gi,
    "$1[REDACTED]",
  ],
  // `-pSECRET` attached to the flag (mysql, sshpass).
  [/(\s-p)(?=[^\s*])[^\s)]+/g, "$1[REDACTED]"],
  // `-u user:pass` / `--user user:pass`.
  [/((?:-u|--user)\s+)([^\s:)]+):[^\s)]+/g, "$1$2:[REDACTED]"],
  // `scheme://user:pass@host`.
  [/([a-z][a-z0-9+.-]*:\/\/)[^\s/@)]+@/gi, "$1[REDACTED]@"],
  // Signed or tokened query parameters.
  [
    /([?&](?:token|key|sig|signature|secret|password|access_token|api_key)=)[^&\s)]+/gi,
    "$1[REDACTED]",
  ],
]

/**
 * A pattern or matcher made safe to show and send: PII redaction plus the
 * credential shapes above. `undefined` when the result would still leak, so
 * the caller drops the row instead of passing it on.
 */
export function sanitizeFactText(text: string): string | undefined {
  let out = redactText(text).redacted
  for (const [pattern, replacement] of RULE_SECRETS) out = out.replace(pattern, replacement)
  return hasNoLeakingPii(out) ? out : undefined
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || "http"
  } catch {
    return "http"
  }
}

function handlerLabel(handler: Record<string, unknown>): { type: string; label: string } {
  const type = typeof handler.type === "string" ? handler.type : "unknown"
  switch (type) {
    case "command":
      return { type, label: commandLabel(String(handler.command ?? "")) }
    case "http":
    case "webhook":
      return { type, label: hostOf(String(handler.url ?? "")) }
    case "mcp_tool":
      return { type, label: `${String(handler.server ?? "?")}/${String(handler.tool ?? "?")}` }
    case "plugin":
      return { type, label: `${String(handler.pluginId ?? "?")}/${String(handler.hookId ?? "?")}` }
    case "prompt":
    case "agent":
      return { type, label: type }
    default:
      return { type, label: type }
  }
}

export function hookFacts(
  scope: AgentConfigHookFact["scope"],
  hooks: ClaudeSettings["hooks"]
): AgentConfigHookFact[] {
  const out: AgentConfigHookFact[] = []
  for (const [event, groups] of Object.entries(hooks ?? {})) {
    if (!Array.isArray(groups)) continue
    for (const group of groups) {
      if (!group || typeof group !== "object") continue
      const { matcher, hooks: handlers } = group as { matcher?: unknown; hooks?: unknown }
      if (!Array.isArray(handlers)) continue
      for (const handler of handlers) {
        if (!handler || typeof handler !== "object") continue
        const safeMatcher =
          typeof matcher === "string" && matcher ? sanitizeFactText(matcher) : undefined
        if (typeof matcher === "string" && matcher && safeMatcher === undefined) continue
        const { type, label } = handlerLabel(handler as Record<string, unknown>)
        out.push({
          scope,
          event,
          ...(safeMatcher ? { matcher: safeMatcher } : {}),
          type,
          label: sanitizeFactText(label) ?? type,
        })
      }
    }
  }
  return out
}

/** `Bash(npm run test:*)` → `{ tool: "Bash", pattern: "npm run test:*" }`; `Read` → `*`. */
export function parseClaudePermission(rule: string): { tool: string; pattern: string } {
  const match = /^([^()]+)\((.*)\)$/.exec(rule.trim())
  if (!match) return { tool: rule.trim(), pattern: "*" }
  return { tool: (match[1] ?? "").trim(), pattern: match[2] ?? "" }
}

export function claudePermissionFacts(
  origin: Extract<AgentConfigPermissionFact["origin"], `claude-${string}`>,
  permissions: ClaudeSettings["permissions"]
): AgentConfigPermissionFact[] {
  const out: AgentConfigPermissionFact[] = []
  for (const verdict of ["allow", "ask", "deny"] as const) {
    const rules = permissions?.[verdict]
    if (!Array.isArray(rules)) continue
    for (const rule of rules) {
      if (typeof rule !== "string" || !rule.trim()) continue
      const parsed = parseClaudePermission(rule)
      const pattern = sanitizeFactText(parsed.pattern)
      if (pattern === undefined) continue
      out.push({ origin, tool: parsed.tool, pattern, verdict })
    }
  }
  return out
}

export function cogniaPermissionFacts(
  toolRules: Ruleset | undefined,
  commandRules: ToolRules | undefined
): AgentConfigPermissionFact[] {
  const tools = listRules(toolRules).flatMap((row): AgentConfigPermissionFact[] => {
    const pattern = sanitizeFactText(row.pattern)
    return pattern === undefined ? [] : [{ origin: "cognia-tools", ...row, pattern }]
  })
  const commands = Object.entries(commandRules ?? {}).flatMap(
    ([raw, verdict]): AgentConfigPermissionFact[] => {
      const pattern = sanitizeFactText(raw)
      return pattern === undefined
        ? []
        : [{ origin: "cognia-commands", tool: "bash", pattern, verdict: String(verdict) }]
    }
  )
  return [...tools, ...commands]
}

export interface AgentConfigFactsDeps {
  readClaudeSettings?: typeof readClaudeEffectiveSettings
  listServers?: typeof listMcpServers
  listAllSkills?: typeof listSkills
  isDesktop?: () => boolean
}

export async function readAgentConfigFacts(
  workspaceId: string | null | undefined,
  deps: AgentConfigFactsDeps = {}
): Promise<AgentConfigFacts> {
  const workspace = resolveAgentConfigWorkspace(workspaceId)
  const settings = useSettingsStore.getState().settings
  const instructions = resolveInstructionsConfig(settings?.instructions)
  const desktop = (deps.isDesktop ?? isTauri)()

  const hooks: AgentConfigHookFact[] = []
  const permissionRules: AgentConfigPermissionFact[] = cogniaPermissionFacts(
    settings?.agentPermissions?.toolRules,
    settings?.agentPermissions?.commandRules
  )
  let hooksAvailable = false
  if (desktop) {
    try {
      const effective = await (deps.readClaudeSettings ?? readClaudeEffectiveSettings)(
        workspace.roots[0] ?? null
      )
      hooksAvailable = true
      hooks.push(
        ...hookFacts("user", effective.user?.hooks),
        ...hookFacts("project", effective.project?.hooks),
        ...hookFacts("local", effective.local?.hooks)
      )
      permissionRules.push(
        ...claudePermissionFacts("claude-user", effective.user?.permissions),
        ...claudePermissionFacts("claude-project", effective.project?.permissions),
        ...claudePermissionFacts("claude-local", effective.local?.permissions)
      )
    } catch {
      hooksAvailable = false
    }
  }

  const [servers, skills] = await Promise.all([
    (deps.listServers ?? listMcpServers)(),
    (deps.listAllSkills ?? listSkills)(),
  ])

  return {
    ...(settings?.defaultModel ? { defaultModel: settings.defaultModel } : {}),
    ...(settings?.activeProviderId ? { defaultProviderId: settings.activeProviderId } : {}),
    instructions: {
      enabled: instructions.enabled,
      mode: instructions.mode,
      fileNames: [...instructions.fileNames],
      includeGlobal: instructions.includeGlobal,
      maxFileBytes: instructions.maxFileBytes,
      loadProjectAgents: instructions.loadProjectAgents,
    },
    hooksAvailable,
    hooks,
    permissionRules,
    mcpServers: servers.map((server) => ({
      id: server.id,
      name: server.name,
      transport: server.transport,
      enabled: server.enabled,
      pluginOwned: Boolean(server.pluginId ?? server.managedBy),
    })),
    skills: {
      total: skills.length,
      enabled: skills.filter((skill) => skill.status !== "disabled").length,
      builtIn: skills.filter((skill) => skill.isBuiltIn).length,
    },
  }
}
