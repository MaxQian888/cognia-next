/**
 * `lib/ai/agent` barrel.
 *
 * This directory is the agent subsystem root. Layout:
 *
 *   - `agent-executor.ts`        one-shot built-in agent runs (plugin dispatch)
 *   - `background-agent-manager` fire-and-forget agents, journaled via Dexie
 *   - `execution/`               execution spec, host environments, capability snapshots
 *   - `external/`                external-agent runtimes: `runtimes/` per-protocol
 *                                clients, `policy/`, `capability/`, `config/`,
 *                                `session/`, `lifecycle/`, plus the manager core
 *   - `recovery/`                crashed-run reconciliation
 *   - `runtime-catalog/`         "what can run the next turn" catalog
 *   - `team/`                    agent-team facade (agent-team*) plus `squad/`,
 *                                `durable/`, `gates/`, `teammate/`, `workers/`,
 *                                `ledger/`, `memory/`, `ultracode/`, `delivery/`,
 *                                `auto/`, `patterns/`, `pr-feedback/`, `workspace/`
 *
 * Historically this barrel also carried the shared type contracts below; keep
 * them here so `types/agent/*` and external consumers keep one import site.
 */

import type { z } from "zod"

export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
  status: "pending" | "running" | "completed" | "error" | "queued" | "timeout" | "cancelled"
  result?: unknown
  error?: string
  startedAt?: Date
  completedAt?: Date
  mcpServerId?: string
  mcpServerName?: string
  isBlocking?: boolean
  executionMode?: "blocking" | "non-blocking"
  priority?: number
  duration?: number
}

export interface AgentTool {
  name: string
  description: string
  parameters: z.ZodType
  execute: (args: Record<string, unknown>) => Promise<unknown>
  requiresApproval?: boolean
}
