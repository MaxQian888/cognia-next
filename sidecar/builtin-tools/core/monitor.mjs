// `Monitor` — block until a condition holds, without burning a turn polling.
//
// Before this the only way to wait was `bash_output({ wait_ms })`, capped at
// 30s and only able to wait on ONE background shell producing any output at
// all. Anything longer, or conditioned on something other than raw bytes, cost
// a full model round-trip per poll.
//
// Two modes, one tool. Short waits block and answer inline. Past
// `BLOCKING_THRESHOLD_MS` the tool stops blocking and hands back a monitorId:
// the watch is durable on the host, survives a restart, and delivers its result
// later through the normal background-result path. The model does not choose
// the mode — it states how long it is willing to wait and the tool degrades on
// its own, so a bad guess costs neither a stalled turn nor a wasted round-trip.

import { z } from "zod"
import { tool } from "@anthropic-ai/claude-agent-sdk"

import { toolError, toolText } from "../safety.mjs"
import { resolveShellInvocation } from "./bash.mjs"
import { HOST_RPC_TIMEOUT_MARGIN_MS } from "../../host-rpc.mjs"

/** Past this, stop blocking and let the durable watch deliver. */
export const BLOCKING_THRESHOLD_MS = 5 * 60_000

/** Longest a single `monitors.wait` round-trip blocks host-side. */
const WAIT_CHUNK_MS = 30_000

/** Hard ceiling on a caller's stated patience (24h — the detached-job TTL). */
export const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000

export const monitorShape = {
  condition: z
    .enum(["job_exit", "job_output", "shell", "upstream"])
    .describe(
      "What to wait for. job_exit: a background shell finishes. job_output: a background shell's output matches a pattern (use this for readiness lines like 'listening on'). shell: a command exits 0 (the general case — port checks, file existence, a passing test run). upstream: a background subagent or scheduled task completes."
    ),
  shellId: z.string().optional().describe("Background shell id, for job_exit and job_output."),
  pattern: z
    .string()
    .optional()
    .describe("Regular expression to match against the shell's output, for job_output."),
  command: z
    .string()
    .optional()
    .describe(
      "Predicate command line, for the shell condition. It is re-run on an interval until it exits 0; keep it cheap and side-effect free."
    ),
  cwd: z.string().optional().describe("Working directory for the shell predicate."),
  interval_ms: z
    .number()
    .int()
    .min(2_000)
    .max(60_000)
    .optional()
    .describe(
      "Initial polling interval for the shell predicate (minimum 2000). Backs off exponentially toward 60000 while the predicate keeps failing."
    ),
  source: z
    .string()
    .optional()
    .describe('Upstream kind, for the upstream condition: "subagent" or "scheduledTask".'),
  id: z.string().optional().describe("Upstream run or task id, for the upstream condition."),
  timeout_ms: z
    .number()
    .int()
    .min(1_000)
    .max(MAX_TIMEOUT_MS)
    .optional()
    .describe(
      `How long you are willing to wait in total (default ${BLOCKING_THRESHOLD_MS}). Up to ${BLOCKING_THRESHOLD_MS} ms this call blocks and returns the outcome; beyond that it returns a monitorId immediately and the result is delivered when it fires.`
    ),
  label: z.string().optional().describe("Short human-readable label shown in the Job Center."),
}

/**
 * Translate the flat tool arguments into the host's tagged condition union.
 * Pure and exported so the argument contract is testable without a host.
 *
 * @returns {{ ok: true, condition: object } | { ok: false, error: string }}
 */
export function buildCondition(args, { resolveShell = resolveShellInvocation } = {}) {
  switch (args.condition) {
    case "job_exit":
      if (!args.shellId) return { ok: false, error: "job_exit requires shellId" }
      return { ok: true, condition: { kind: "jobExit", jobId: args.shellId } }
    case "job_output": {
      if (!args.shellId) return { ok: false, error: "job_output requires shellId" }
      if (!args.pattern) return { ok: false, error: "job_output requires pattern" }
      try {
        new RegExp(args.pattern)
      } catch (err) {
        // Reject here rather than registering a watch that can never match.
        return { ok: false, error: `invalid pattern: ${err?.message ?? err}` }
      }
      return {
        ok: true,
        condition: { kind: "jobOutput", jobId: args.shellId, pattern: args.pattern },
      }
    }
    case "shell": {
      if (!args.command) return { ok: false, error: "shell requires command" }
      const { shell, shellArgs, env } = resolveShell(args.command)
      return {
        ok: true,
        condition: {
          kind: "shellPredicate",
          command: args.command,
          program: shell,
          args: shellArgs,
          cwd: args.cwd ?? process.cwd(),
          env: { ...env },
          ...(args.interval_ms ? { intervalMs: args.interval_ms } : {}),
        },
      }
    }
    case "upstream":
      if (!args.source) return { ok: false, error: "upstream requires source" }
      if (!args.id) return { ok: false, error: "upstream requires id" }
      return { ok: true, condition: { kind: "upstream", source: args.source, id: args.id } }
    default:
      return { ok: false, error: `unknown condition: ${args.condition}` }
  }
}

/** Render a settled monitor for the model. */
export function describeOutcome(record) {
  const detail = record.detail ? ` — ${record.detail}` : ""
  switch (record.status) {
    case "fired":
      return `condition met${detail}`
    case "unsatisfiable":
      return `condition can no longer be met${detail}`
    case "cancelled":
      return `monitor cancelled${detail}`
    case "expired":
      return `monitor expired${detail}`
    default:
      return `monitor is still waiting${detail}`
  }
}

/**
 * @param {{
 *   hostRpc?: { call: (m: string, p: any, o?: any) => Promise<any> },
 *   sessionId?: string,
 *   blockingThresholdMs?: number,
 *   waitChunkMs?: number,
 * }} ctx
 */
export function createMonitorTool({
  hostRpc,
  sessionId,
  blockingThresholdMs = BLOCKING_THRESHOLD_MS,
  waitChunkMs = WAIT_CHUNK_MS,
}) {
  async function execMonitor(args) {
    if (!hostRpc) {
      return toolError("monitors are not available in this session")
    }
    const built = buildCondition(args)
    if (!built.ok) return toolError(built.error)

    const budget = Math.min(args.timeout_ms ?? BLOCKING_THRESHOLD_MS, MAX_TIMEOUT_MS)
    const willBlock = Math.min(budget, blockingThresholdMs)
    const owner = { kind: "session", sessionId }

    let record
    try {
      record = await hostRpc.call("monitors.register", {
        condition: built.condition,
        owner,
        // The deadline covers the caller's FULL patience, not just the part we
        // block for — otherwise a degraded watch would expire early.
        expiresAtMs: Date.now() + budget,
        label: args.label ?? null,
      })
    } catch (err) {
      return toolError(String(err?.message ?? err), "Monitor")
    }

    const deadline = Date.now() + willBlock
    while (Date.now() < deadline) {
      const remaining = Math.min(waitChunkMs, deadline - Date.now())
      try {
        record = await hostRpc.call(
          "monitors.wait",
          { monitorId: record.id, waitMs: remaining },
          { timeoutMs: remaining + HOST_RPC_TIMEOUT_MARGIN_MS }
        )
      } catch (err) {
        return toolError(String(err?.message ?? err), "Monitor")
      }
      if (record.status !== "waiting") {
        return toolText(`${describeOutcome(record)} (monitor ${record.id})`)
      }
    }

    // Degraded to an async watch. Say so explicitly, and name the escape hatch
    // — a silent "still waiting" reads like a failure.
    return toolText(
      `Still waiting after ${Math.round(willBlock / 1000)}s, so this is now a background watch (monitor ${record.id}, waiting for ${describeCondition(args)}). ` +
        `You will be told when it fires; carry on with other work. Stop it with monitor_cancel({ monitorId: "${record.id}" }).`
    )
  }

  return tool(
    "Monitor",
    "Wait until a condition holds: a background shell exits, its output matches a pattern, a predicate command exits 0, or an upstream subagent/scheduled task completes. Blocks and answers inline for short waits; past a few minutes it converts to a background watch and tells you when it fires, so a long wait costs no polling.",
    monitorShape,
    execMonitor
  )
}

function describeCondition(args) {
  switch (args.condition) {
    case "job_exit":
      return `shell ${args.shellId} to exit`
    case "job_output":
      return `shell ${args.shellId} output to match /${args.pattern}/`
    case "shell":
      return `\`${args.command}\` to exit 0`
    case "upstream":
      return `${args.source} ${args.id} to complete`
    default:
      return "the condition"
  }
}

export function createMonitorCancelTool({ hostRpc, sessionId }) {
  async function execCancel(args) {
    if (!hostRpc) return toolError("monitors are not available in this session")
    try {
      const record = await hostRpc.call("monitors.cancel", {
        monitorId: args.monitorId,
        requester: { kind: "session", sessionId },
      })
      return toolText(`monitor ${record.id} is now ${record.status}`)
    } catch (err) {
      return toolError(String(err?.message ?? err), "monitor_cancel")
    }
  }

  return tool(
    "monitor_cancel",
    "Stop a background watch started by Monitor. Idempotent.",
    { monitorId: z.string().min(1).describe("The monitorId returned by Monitor.") },
    execCancel
  )
}

export function createMonitorListTool({ hostRpc, sessionId }) {
  async function execList() {
    if (!hostRpc) return toolError("monitors are not available in this session")
    try {
      const { monitors } = await hostRpc.call("monitors.list", {
        owner: { kind: "session", sessionId },
      })
      return toolText(JSON.stringify({ monitors: monitors ?? [] }, null, 2))
    } catch (err) {
      return toolError(String(err?.message ?? err), "monitor_list")
    }
  }

  return tool(
    "monitor_list",
    "List this session's monitors, including background watches that have not fired yet.",
    {},
    execList
  )
}

export const MONITOR_TOOL_NAMES = Object.freeze(["Monitor", "monitor_cancel", "monitor_list"])

/** Build all three monitor tools in the fixed registration order. */
export function createMonitorTools(ctx = {}) {
  return [createMonitorTool(ctx), createMonitorCancelTool(ctx), createMonitorListTool(ctx)]
}
