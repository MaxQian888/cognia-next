/**
 * Thin wrapper around `lib/db/mcp-audit-log.ts` that owns the policy of
 * "what every MCP request gets logged with". The bridge handlers / server
 * skeleton call `recordCall` once per request — the wrapper fills in `ts`
 * and converts a `ScopeCheckResult` into the right `allowed` / `reason`
 * shape so call sites don't repeat the boilerplate.
 *
 * Logging never throws — if the Dexie write fails (db deleted out from
 * under us, schema mid-migration), we swallow + console.warn so a logging
 * failure can't ever break a successful MCP response.
 */

import type { BridgeScope, McpAuditLogRow } from "@/types/wiki"
import { appendMcpAuditLog } from "@/lib/db/mcp-audit-log"
import type { ScopeCheckResult } from "./types"

export interface RecordCallInput {
  /** Tool / method name, e.g. "wiki_search" / "tools/list". */
  tool: string
  /**
   * Scope checked for this call, or "n/a" for protocol-level methods that
   * don't touch user content (e.g. `initialize`, `tools/list`).
   */
  scope: BridgeScope | "n/a"
  /** Outcome of the permission gate (or `{allowed: true}` for n/a calls). */
  check: ScopeCheckResult
  /** Wall-clock latency in ms — caller times the handler. */
  latencyMs: number
  /** Bounded classifier set when the allowed handler failed. */
  errorCode?: string
}

/**
 * Append one audit row. Returns the persisted row on success, `undefined`
 * if the write failed (caller doesn't need to react — failures are
 * already logged to the console).
 */
export async function recordCall(input: RecordCallInput): Promise<McpAuditLogRow | undefined> {
  try {
    const row = await appendMcpAuditLog({
      ts: Date.now(),
      tool: input.tool,
      scope: input.scope,
      allowed: input.check.allowed,
      latencyMs: input.latencyMs,
      reason: input.check.allowed ? undefined : input.check.reason,
      errorCode: input.errorCode,
      direction: "inbound",
      phase: "call",
      executionSurface: "bridge",
      decision: input.check.allowed ? "allow" : "deny",
      durationMs: input.latencyMs,
    })
    return row
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn("[external-bridge] audit log write failed:", msg)
    return undefined
  }
}
