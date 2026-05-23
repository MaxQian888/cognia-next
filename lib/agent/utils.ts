/**
 * Agent utility functions extracted from UI components.
 *
 * Pure functions and helpers that don't depend on React lifecycle.
 */

import type { ToolState } from "@/types/core/message"
import type { BackgroundAgent } from "@/types/agent/background-agent"
import type { ReplayEvent } from "@/types/agent/component-types"
import type { AgentTraceRecord } from "@/types/agent/agent-trace"
import type { DBAgentTrace } from "@/lib/db"
import type { LucideIcon } from "lucide-react"
import {
  Clock,
  CheckCircle,
  XCircle,
  Loader2,
  AlertTriangle,
  Play,
  CheckCircle2,
  Wrench,
  MessageSquare,
  Brain,
  Pause,
  Ban,
  GitBranch,
} from "lucide-react"
import type { TeamTaskStatus } from "@/types/agent/agent-team"
import { loggers } from "@/lib/logging"

const agentUtilsLogger = loggers.agent.child("utils")

// ============================================================================
// Tool Timeline Constants & Helpers
// ============================================================================

/**
 * State configuration for tool timeline visualization
 */
export const TOOL_STATE_CONFIG: Record<
  ToolState,
  { icon: LucideIcon; color: string; label: string }
> = {
  "input-streaming": {
    icon: Loader2,
    color: "text-blue-500",
    label: "Preparing",
  },
  "input-available": {
    icon: Loader2,
    color: "text-blue-500",
    label: "Running",
  },
  "approval-requested": {
    icon: AlertTriangle,
    color: "text-yellow-500",
    label: "Awaiting Approval",
  },
  "approval-responded": {
    icon: Clock,
    color: "text-blue-500",
    label: "Approved",
  },
  "output-available": {
    icon: CheckCircle,
    color: "text-green-500",
    label: "Completed",
  },
  "output-error": {
    icon: XCircle,
    color: "text-red-500",
    label: "Error",
  },
  "output-denied": {
    icon: XCircle,
    color: "text-orange-500",
    label: "Denied",
  },
}

/**
 * Format a tool name from snake_case/kebab-case to Title Case
 */
export function formatToolName(name: string): string {
  return name
    .split(/[-_]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}

// ============================================================================
// Agent Steps Constants
// ============================================================================

/**
 * Priority configuration for agent steps
 */
export const STEP_PRIORITY_CONFIG: Record<string, { color: string }> = {
  low: { color: "text-muted-foreground" },
  normal: { color: "text-blue-500" },
  high: { color: "text-orange-500" },
  critical: { color: "text-red-500" },
}

// ============================================================================
// Agent Team Graph Constants
// ============================================================================

/**
 * Status icons mapping for graph nodes
 */
export const GRAPH_STATUS_ICONS: Record<string, LucideIcon> = {
  idle: Clock,
  planning: GitBranch,
  awaiting_approval: Pause,
  executing: Loader2,
  paused: Pause,
  completed: CheckCircle2,
  failed: XCircle,
  cancelled: Ban,
  shutdown: Ban,
}

/**
 * Priority dot colors for task nodes in graph
 */
export const PRIORITY_DOT_COLORS: Record<string, string> = {
  critical: "bg-red-500",
  high: "bg-orange-500",
  normal: "bg-blue-500",
  low: "bg-gray-400",
  background: "bg-gray-300",
}

// ============================================================================
// Agent Team Task Board Constants
// ============================================================================

/**
 * Kanban column configuration
 */
export const TASK_BOARD_COLUMNS: {
  id: string
  statuses: TeamTaskStatus[]
  labelKey: string
  color: string
}[] = [
  {
    id: "blocked",
    statuses: ["blocked"],
    labelKey: "taskBoard.columnBlocked",
    color: "border-orange-500/30",
  },
  {
    id: "pending",
    statuses: ["pending", "claimed"],
    labelKey: "taskBoard.columnPending",
    color: "border-blue-500/30",
  },
  {
    id: "in_progress",
    statuses: ["in_progress"],
    labelKey: "taskBoard.columnInProgress",
    color: "border-primary/30",
  },
  {
    id: "review",
    statuses: ["review"],
    labelKey: "taskBoard.columnReview",
    color: "border-yellow-500/30",
  },
  {
    id: "done",
    statuses: ["completed", "failed", "cancelled"],
    labelKey: "taskBoard.columnDone",
    color: "border-green-500/30",
  },
]

/**
 * Priority colors for task board cards
 */
export const TASK_PRIORITY_COLORS: Record<string, string> = {
  critical: "bg-red-500/20 text-red-600 border-red-500/30",
  high: "bg-orange-500/20 text-orange-600 border-orange-500/30",
  normal: "bg-blue-500/20 text-blue-600 border-blue-500/30",
  low: "bg-gray-500/20 text-gray-600 border-gray-500/30",
  background: "bg-gray-400/20 text-gray-500 border-gray-400/30",
}

// ============================================================================
// Session Replay & Live Trace Constants
// ============================================================================

/**
 * Event type to icon mapping for session replay
 */
export const REPLAY_EVENT_ICONS: Record<string, LucideIcon> = {
  session_start: Play,
  session_end: CheckCircle2,
  permission_request: AlertTriangle,
  permission_response: CheckCircle,
  step_start: Play,
  step_finish: CheckCircle2,
  tool_call_request: Wrench,
  tool_call_result: Wrench,
  planning: Brain,
  response: MessageSquare,
  error: AlertTriangle,
}

/**
 * Event type to icon mapping for live trace panel
 */
export const LIVE_TRACE_EVENT_ICONS: Record<string, LucideIcon> = {
  session_start: Play,
  session_end: CheckCircle2,
  permission_request: AlertTriangle,
  permission_response: CheckCircle,
  step_start: Play,
  step_finish: Pause,
  tool_call_request: MessageSquare,
  tool_call_result: Wrench,
  planning: Brain,
  response: MessageSquare,
  error: AlertTriangle,
  checkpoint_create: CheckCircle2,
  checkpoint_restore: XCircle,
}

/**
 * Event type to color mapping for live trace panel
 */
export const LIVE_TRACE_EVENT_COLORS: Record<string, string> = {
  session_start: "text-blue-500",
  session_end: "text-emerald-500",
  permission_request: "text-amber-500",
  permission_response: "text-green-500",
  step_start: "text-blue-500",
  step_finish: "text-blue-400",
  tool_call_request: "text-amber-500",
  tool_call_result: "text-green-500",
  planning: "text-purple-500",
  response: "text-teal-500",
  error: "text-red-500",
  checkpoint_create: "text-sky-500",
  checkpoint_restore: "text-orange-500",
}

// ============================================================================
// Formatting Utilities
// ============================================================================

/**
 * Format bytes to human readable string
 */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || bytes === 0) return "0 B"
  const k = 1024
  const sizes = ["B", "KB", "MB", "GB"]
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
}

// Re-export canonical formatTokens from observability module
export { formatTokens } from "@/lib/observability/format-utils"

/**
 * Format duration in milliseconds to compact string
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}

/**
 * Build a stable workspace route for Agent Team entrypoints.
 */
export function buildAgentTeamWorkspaceHref(teamId?: string | null): string {
  if (!teamId) return "/agent-teams"
  return `/agent-teams?team=${encodeURIComponent(teamId)}`
}

// ============================================================================
// File Export Utilities
// ============================================================================

/**
 * Browser-side file download helper.
 *
 * @deprecated Import from `@/lib/files/download` instead. This re-export is
 * kept temporarily so existing call sites continue to compile during the
 * migration. New code should import the canonical location.
 */
export { downloadFile } from "@/lib/files/download"

/**
 * Format a background agent as markdown for export
 */
export function formatAgentAsMarkdown(agent: BackgroundAgent): string {
  const lines: string[] = [
    `# ${agent.name}`,
    "",
    `**Status:** ${agent.status}`,
    `**Task:** ${agent.task}`,
    `**Progress:** ${agent.progress}%`,
    "",
    agent.startedAt ? `**Started:** ${agent.startedAt.toISOString()}` : "",
    agent.completedAt ? `**Completed:** ${agent.completedAt.toISOString()}` : "",
    "",
    "## Sub-Agents",
    "",
    ...agent.subAgents.map((sa) => `- **${sa.name}** (${sa.status}): ${sa.task || "No task"}`),
    "",
    "## Logs",
    "",
    ...agent.logs.map(
      (log) => `- [${log.level.toUpperCase()}] ${log.timestamp.toISOString()}: ${log.message}`
    ),
  ]
  return lines.filter(Boolean).join("\n")
}

// ============================================================================
// Session Replay Utilities
// ============================================================================

/**
 * Parse a raw DB agent trace into a ReplayEvent
 */
export function parseReplayEvent(row: DBAgentTrace): ReplayEvent | null {
  try {
    const record = JSON.parse(row.record) as AgentTraceRecord
    const meta = record.metadata as Record<string, unknown> | undefined
    const tu = meta?.tokenUsage as ReplayEvent["tokenUsage"] | undefined

    return {
      id: record.id,
      timestamp: new Date(record.timestamp).getTime(),
      eventType: record.eventType ?? "response",
      stepId: record.stepId,
      toolName: meta?.toolName as string | undefined,
      success: meta?.success as boolean | undefined,
      duration: record.duration ?? (meta?.latencyMs as number | undefined),
      tokenUsage: tu,
      cost: record.costEstimate?.totalCost,
      error: meta?.error as string | undefined,
      responsePreview: meta?.responsePreview as string | undefined,
      files: record.files.map((f) => f.path).filter(Boolean),
    }
  } catch (error) {
    agentUtilsLogger.warn("Failed to parse agent trace row", { traceId: row.id, error })
    return null
  }
}
