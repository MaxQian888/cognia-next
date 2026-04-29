/**
 * Minimal `lib/ai/agent` barrel for cognia-next.
 *
 * The Cognia source defines a much richer agent runtime here (executor,
 * loop, tool-call manager, orchestrator, MCP bridges, etc.). cognia-next
 * does not need that machinery for the External-Agent migration — only
 * the type contracts that `lib/ai/agent/external/*` and `types/agent/*`
 * import.
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
