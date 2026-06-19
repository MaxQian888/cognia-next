/**
 * Agent component-specific type definitions
 *
 * Types extracted from agent UI components to maintain
 * clean separation of concerns.
 */

import type { ToolState } from "@/types/core/message"
import type { McpServerStatus } from "@/types/mcp"
import type { AgentTraceEventType } from "@/types/agent/agent-trace"
import type { ExternalAgentProtocol, ExternalAgentTransport } from "@/types/agent/external-agent"

// ============================================================================
// Tool Timeline Types
// ============================================================================

/**
 * Tool execution entry for the ToolTimeline component.
 * Different from types/agent/tool.ts ToolExecution which uses AgentToolStatus.
 * This one uses ToolState (state machine) for timeline visualization.
 */
export interface TimelineToolExecution {
  id: string
  toolName: string
  state: ToolState
  args?: Record<string, unknown>
  result?: unknown
  error?: string
  startTime?: Date
  endTime?: Date
  checkpointLabel?: string
  isCheckpoint?: boolean
  /** MCP server ID (if this is an MCP tool call) */
  serverId?: string
  /** MCP server display name */
  serverName?: string
  /** MCP server status */
  serverStatus?: McpServerStatus
}

/**
 * Pending tool in the execution queue
 */
export interface PendingTool {
  id: string
  toolName: string
  estimatedDuration?: number
  position: number
}

// ============================================================================
// Background Agent Types
// ============================================================================

/**
 * Performance statistics for background agent display
 */
export interface PerformanceStats {
  totalTasks: number
  completedTasks: number
  failedTasks: number
  averageDuration: number
  successRate: number
  activeSubAgents: number
  toolCallsTotal: number
  tokenUsage: number
}

// ============================================================================
// Agent Steps Types
// ============================================================================

/**
 * Individual step in agent execution
 */
export interface AgentStep {
  id: string
  name: string
  description?: string
  status: "pending" | "running" | "completed" | "error"
  startedAt?: Date
  completedAt?: Date
  isCheckpoint?: boolean
  checkpointLabel?: string
  priority?: "low" | "normal" | "high" | "critical"
  retryCount?: number
}

// ============================================================================
// Session Replay Types
// ============================================================================

/**
 * Parsed replay event for session playback
 */
export interface ReplayEvent {
  id: string
  timestamp: number
  eventType: AgentTraceEventType
  stepId?: string
  toolName?: string
  success?: boolean
  duration?: number
  tokenUsage?: { promptTokens: number; completionTokens: number; totalTokens: number }
  cost?: number
  error?: string
  responsePreview?: string
  files: string[]
}

// ============================================================================
// External Agent Manager Types
// ============================================================================

/**
 * Form data for adding a new external agent
 */
export interface AddAgentFormData {
  name: string
  protocol: ExternalAgentProtocol
  transport: ExternalAgentTransport
  command: string
  args: string
  /** Convenience: append `--bare` to spawn args. Maps to `process.bare`. */
  bare: boolean
  /** Convenience: append `--debug` to spawn args. Maps to `process.debug`. */
  debug: boolean
  endpoint: string
  /** OpenCode: auto-spawn a local `opencode serve` process (desktop only). */
  autoSpawnServer: boolean
  /** OpenCode: server port (empty = default 4096 / auto-pick when spawning). */
  port: string
  /** OpenCode: HTTP Basic Auth password (OPENCODE_SERVER_PASSWORD). */
  serverPassword: string
  timeoutMs: string
  retryMaxRetries: string
  retryDelayMs: string
  retryExponentialBackoff: boolean
  retryMaxDelayMs: string
  retryOnErrors: string
}

// ============================================================================
// Agent Team Task Board Types
// ============================================================================

/**
 * Form data for creating a new team task
 */
export interface TaskCreateForm {
  title: string
  description: string
  priority: string
  assignedTo: string
}

// ============================================================================
// Agent Team Graph Types
// ============================================================================

/**
 * View mode for the agent team graph
 */
export type GraphViewMode = "team" | "tasks"
