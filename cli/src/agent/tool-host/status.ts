/**
 * The live Cognia-parity facts, published by the session and read by `/status`
 * and `/doctor`.
 *
 * The session owns the broker; the diagnostics panels are built by controllers
 * that never see it. Without a published snapshot those panels could only repeat
 * static backend assumptions — which is exactly the "capability UI models
 * transport support, not parity" gap. A tiny registry keyed by chat session id
 * keeps the reporting honest without handing the controllers a broker handle
 * they could act on.
 */

import type {
  AgentCapabilityId,
  CanonicalAgentEvent,
} from "@cognia/agent-config-types/agent-execution"
import type { SendOptions } from "@cognia/agent-config-types"
import { BUILTIN_TOOL_CATEGORIES } from "@/lib/settings/builtin-tools"
import type { ResolvedCliSessionContext } from "../session-context"
import { visibleBuiltinTools, visibleHostTools } from "./policy"

export interface ToolReadiness {
  state: "disabled" | "initializing" | "ready" | "failed"
  reason?: string
}

export interface BuiltinHostReadiness {
  phase: "initializing" | "ready" | "failed"
  reason?: string
  runtime?: string
  capabilities: AgentCapabilityId[]
  permissionMode?: SendOptions["permissionMode"]
  skills: boolean
  categories: Record<string, ToolReadiness>
}

export interface ToolHostSnapshot {
  builtin?: BuiltinHostReadiness
  /** The backend these facts describe. */
  backend: string
  /** Fingerprint of the resolved context the session is running under. */
  contextVersion: string
  /** The protocol can carry an MCP server at `session/new`. */
  attachable: boolean
  /** The broker is up and the bridge entries were attached. */
  running: boolean
  /** Effective `cognia-tools` count under the current policy. */
  builtinToolCount: number
  /** Effective `cognia-plugin-tools` count under the current policy. */
  hostToolCount: number
  /** True when `dispatch_agent` is among the projected host tools. */
  subagentDispatch: boolean
  /** Enabled user MCP servers forwarded alongside Cognia's own. */
  userMcpCount: number
  /** Bridges currently connected to the broker. */
  connections: number
}

const snapshots = new Map<string, ToolHostSnapshot>()

/** Publish the resolved policy and host state without promoting lazy services to ready. */
export function publishBuiltinToolHostStatus(
  session: ResolvedCliSessionContext,
  phase: BuiltinHostReadiness["phase"],
  reason?: string
): ToolHostSnapshot {
  const options = session.sendOptions
  const visible = new Set(visibleBuiltinTools(options))
  const hostTools = phase === "ready" ? visibleHostTools(options) : []
  const previous = snapshots.get(session.sessionId)
  const categories: Record<string, ToolReadiness> = {}
  const sandboxFailure = options.builtinProcessSandbox?.unavailableReason
  if (options.builtinProcessSandbox) {
    categories.sandbox = sandboxFailure
      ? { state: "failed", reason: sandboxFailure }
      : { state: phase, ...(reason ? { reason } : {}) }
  }
  for (const category of BUILTIN_TOOL_CATEGORIES) {
    if (!options.builtinTools?.[category.id]) {
      categories[category.id] = {
        state: "disabled",
        reason: "Disabled in the session configuration",
      }
    } else if (!category.tools.some((tool) => visible.has(tool.name))) {
      categories[category.id] = {
        state: "disabled",
        reason: "Excluded by the effective tool policy",
      }
    } else if (phase !== "ready") {
      categories[category.id] = { state: phase, reason: reason ?? "Waiting for the tool host" }
    } else if (
      sandboxFailure &&
      ["process", "shellAdvanced", "terminalRepl", "git"].includes(category.id)
    ) {
      categories[category.id] = { state: "failed", reason: sandboxFailure }
    } else if (category.id === "lsp" && !options.lsp?.enabled) {
      categories[category.id] = { state: "failed", reason: "LSP configuration was not resolved" }
    } else if (
      [
        "lsp",
        "codeGraph",
        "astGrep",
        "terminalRepl",
        "git",
        "dependencyResearch",
        "webclone",
      ].includes(category.id)
    ) {
      categories[category.id] =
        previous?.contextVersion === session.contextVersion && previous.builtin?.phase === "ready"
          ? (previous.builtin.categories[category.id] ?? {
              state: "initializing",
              reason: "Initialized on first use",
            })
          : { state: "initializing", reason: "Initialized on first use" }
    } else {
      categories[category.id] = { state: "ready" }
    }
  }
  const snapshot: ToolHostSnapshot = {
    backend: "builtin",
    contextVersion: session.contextVersion,
    attachable: true,
    running: phase === "ready",
    builtinToolCount: phase === "ready" ? visible.size : 0,
    hostToolCount: hostTools.length,
    subagentDispatch: hostTools.includes("dispatch_agent"),
    userMcpCount: session.mcpServers.length,
    connections: phase === "ready" ? 1 : 0,
    builtin: {
      phase,
      ...(reason ? { reason } : {}),
      runtime: options.execution?.runtimeAdapter,
      capabilities: [...(options.execution?.capabilities.effective ?? [])],
      permissionMode: options.permissionMode,
      skills: session.activeSkillIds.length > 0 || session.contextualSkills.length > 0,
      categories,
    },
  }
  publishToolHostStatus(session.sessionId, snapshot)
  return snapshot
}

/** A successful request proves readiness; dependency errors retain their repair reason. */
export function observeBuiltinToolResult(
  sessionId: string,
  event: CanonicalAgentEvent
): ToolHostSnapshot | undefined {
  const snapshot = snapshots.get(sessionId)
  if (snapshot?.builtin?.phase !== "ready" || event.kind !== "tool-result") return undefined
  const prefix = "mcp__cognia-tools__"
  const name = event.toolName.startsWith(prefix)
    ? event.toolName.slice(prefix.length)
    : event.toolName
  const category = BUILTIN_TOOL_CATEGORIES.find((entry) =>
    entry.tools.some((tool) => tool.name === name)
  )
  if (!category || snapshot.builtin.categories[category.id]?.state === "disabled") return undefined
  // Diagnostics can be served from an empty cache without starting a language server.
  if (!event.isError && name === "lsp_diagnostics") return undefined
  let readiness: ToolReadiness = { state: "ready" }
  if (event.isError) {
    const reason = typeof event.result === "string" ? event.result : JSON.stringify(event.result)
    if (
      !/unavailable|not available|not executable|spawn failed|not found|not installed|ENOENT|resolver|missing.*(?:binary|host)/i.test(
        reason ?? ""
      )
    )
      return undefined
    readiness = { state: "failed", reason: reason.slice(0, 400) }
  }
  const next = {
    ...snapshot,
    builtin: {
      ...snapshot.builtin,
      categories: { ...snapshot.builtin.categories, [category.id]: readiness },
    },
  }
  publishToolHostStatus(sessionId, next)
  return next
}

/** Record (or replace) the parity snapshot for a session. */
export function publishToolHostStatus(sessionId: string, snapshot: ToolHostSnapshot): void {
  snapshots.set(sessionId, snapshot)
}

/** Read a session's snapshot, or undefined when nothing has been published. */
export function readToolHostStatus(sessionId: string): ToolHostSnapshot | undefined {
  return snapshots.get(sessionId)
}

/** Drop a session's snapshot — the session ended or switched backends. */
export function clearToolHostStatus(sessionId: string): void {
  snapshots.delete(sessionId)
}

/** The most recently published snapshot, for surfaces that have no session id. */
export function latestToolHostStatus(): ToolHostSnapshot | undefined {
  let last: ToolHostSnapshot | undefined
  for (const snapshot of snapshots.values()) last = snapshot
  return last
}

/** Test-only — wipe the registry. */
export function __resetToolHostStatusForTesting(): void {
  snapshots.clear()
}
