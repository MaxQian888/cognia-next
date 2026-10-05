import { matchGlob } from "@/lib/claude/permissions/ruleset"

/**
 * Decide whether a tool call is pre-approved by a `dontAsk` allow-list.
 *
 * `dontAsk` never surfaces a permission prompt: a tool matching the allow-list
 * is silently approved and everything else is denied. Entries follow the Claude
 * Agent SDK `allowedTools` format:
 *
 * - A bare tool name (`"Read"`, or `"*"` for any) approves the tool regardless
 *   of its input.
 * - A `Tool(specifier)` entry additionally requires the call's derived target
 *   (shell command / file path / url / …) to match the `specifier` glob. When
 *   no target can be derived, the specifier cannot be satisfied so the call is
 *   NOT approved — `dontAsk` fails closed.
 *
 * Tool-name and specifier matching both reuse {@link matchGlob}, so `*`/`?`
 * wildcards behave exactly as they do in the built-in permission engine.
 */
export function isToolPreApproved(
  toolName: string | undefined,
  rawInput: Record<string, unknown> | undefined,
  allowedTools: string[] | undefined
): boolean {
  if (!allowedTools?.length || !toolName) return false
  for (const entry of allowedTools) {
    if (!entry) continue
    const openParen = entry.indexOf("(")
    const base = openParen >= 0 ? entry.slice(0, openParen).trim() : entry.trim()
    if (!base || !matchGlob(base, toolName)) continue
    // Tool-level allow (no specifier) — approve regardless of input.
    if (openParen < 0) return true
    const closeParen = entry.lastIndexOf(")")
    const specifier = entry.slice(openParen + 1, closeParen > openParen ? closeParen : entry.length)
    const target = deriveTarget(rawInput)
    if (target != null && matchGlob(specifier, target)) return true
  }
  return false
}

/** What a configuration's own approval lists say about one permission request. */
export type ConfiguredApprovalPolicy = "ask" | "approve" | null

/** The fields of a permission request the approval lists can match. */
export interface ApprovalPolicyRequest {
  title?: string
  kind?: string
  toolInfo?: { name?: string }
  rawInput?: Record<string, unknown>
}

/**
 * Apply a configuration's `requireApprovalFor` / `autoApprovePatterns` to one
 * permission request the agent sent to Cognia.
 *
 * Entries use the `allowedTools` syntax above (`Tool` or `Tool(specifier)`,
 * `*`/`?` globs) and match the request's title, its tool name or its kind
 * (`execute`, `edit`, `read`, …), because runtimes name the same call
 * differently: ACP sends a title, Codex the command line, every runtime a
 * kind. `requireApprovalFor` wins: a request it matches is always shown to the
 * user, even in a mode that would otherwise approve it (`acceptEdits`,
 * `bypassPermissions`), and it is denied in a mode that never shows UI
 * (`dontAsk`). Otherwise `autoApprovePatterns` approves it without a prompt.
 * `null` leaves the decision to the permission mode.
 *
 * Only requests that reach Cognia can be governed: a runtime running with its
 * own approvals switched off (Codex in `bypassPermissions`) sends none.
 */
export function configuredApprovalPolicy(
  config: { autoApprovePatterns?: string[]; requireApprovalFor?: string[] } | undefined,
  request: ApprovalPolicyRequest
): ConfiguredApprovalPolicy {
  if (!config) return null
  const names = Array.from(
    new Set(
      [request.title, request.toolInfo?.name, request.kind].filter(
        (name): name is string => typeof name === "string" && name.length > 0
      )
    )
  )
  const matches = (list: string[] | undefined) =>
    names.some((name) => isToolPreApproved(name, request.rawInput, list))
  if (matches(config.requireApprovalFor)) return "ask"
  if (matches(config.autoApprovePatterns)) return "approve"
  return null
}

/**
 * Best-effort extraction of the glob target from a tool call's raw input. Reads
 * the conventional input keys used across the built-in tools (shell command,
 * file path, url, search pattern). Returns `undefined` when none is present so
 * a specifier-qualified rule fails closed.
 */
function deriveTarget(rawInput: Record<string, unknown> | undefined): string | undefined {
  if (!rawInput) return undefined
  for (const key of ["command", "file_path", "filePath", "path", "url", "pattern"]) {
    const value = rawInput[key]
    if (typeof value === "string" && value) return value
  }
  return undefined
}

/** Match only an actually mounted Cognia bridge namespace, never an agent tool title. */
export function isCogniaProjectedTool(
  toolName: string | undefined,
  mountedServers: readonly string[] = ["cognia-tools", "cognia-plugin-tools"]
): boolean {
  if (!toolName) return false
  return mountedServers.some(
    (server) =>
      (server === "cognia-tools" || server === "cognia-plugin-tools") &&
      toolName.startsWith(`mcp__${server}__`)
  )
}
