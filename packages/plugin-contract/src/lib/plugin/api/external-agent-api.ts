/**
 * The plugin contract's share of `lib/plugin/api/external-agent-api.ts`, which re-exports these.
 */
import type {
  ExternalAgentExecutionOptions,
  ExternalAgentResult,
} from "../../../types/agent/external-agent"
import type { PluginWorkspaceHandle } from "../workspace/acquire"

export type PluginBotExternalAgentPermissionMode = "acceptEdits" | "bypassPermissions"

export type PluginExternalAgentOptions = Omit<ExternalAgentExecutionOptions, "permissionMode"> & {
  workspace?: PluginWorkspaceHandle
  timeoutMs?: number
  /** Stable step identity; use a new id for a deliberately subsequent turn. */
  invocationId?: string
} & (
    | { runId: string; permissionMode?: PluginBotExternalAgentPermissionMode }
    | { runId?: undefined; permissionMode?: ExternalAgentExecutionOptions["permissionMode"] }
  )

export interface PluginExternalAgentResult extends ExternalAgentResult {
  agentId: string
  model?: string
  status: "completed" | "failed" | "cancelled" | "recovery_required"
  text: string
  usage?: ExternalAgentResult["tokenUsage"]
  /**
   * What this invocation cost in USD, recorded in the run's cost ledger.
   * `null` when it could not be priced; absent outside Bot runs.
   */
  costUsd?: number | null
}
