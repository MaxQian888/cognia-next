/**
 * Background Agent Type Definitions
 * Defines types for agents that run in the background without blocking the UI
 */

import type { SubAgent, SubAgentResult, SubAgentOrchestrationResult } from "./sub-agent"
import type { AgentTool, ToolCall } from "@/lib/ai/agent"
import type { ProviderName } from "@cognia/provider-types/provider"

/**
 * Background agent execution status
 */
export type BackgroundAgentStatus =
  | "idle" // Not started
  | "queued" // Waiting in queue
  | "initializing" // Setting up execution
  | "running" // Currently executing
  | "paused" // Paused by user
  | "waiting" // Waiting for user input or approval
  | "completed" // Successfully completed
  | "failed" // Execution failed
  | "cancelled" // Cancelled by user
  | "timeout" // Execution timed out

/**
 * Background agent notification type
 */
export type BackgroundAgentNotificationType =
  | "started"
  | "progress"
  | "step_complete"
  | "sub_agent_complete"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "cancelled"

/**
 * Background agent notification
 */
export interface BackgroundAgentNotification {
  id: string
  agentId: string
  type: BackgroundAgentNotificationType
  title: string
  message: string
  timestamp: Date
  read: boolean
  data?: unknown
  actions?: Array<{
    label: string
    action: string
    variant?: "default" | "destructive" | "outline"
  }>
}

/**
 * Background agent configuration
 */
export interface BackgroundAgentConfig {
  /** Whether to run in background (non-blocking) */
  runInBackground: boolean
  /** Whether to show notifications */
  notifyOnProgress: boolean
  /** Whether to notify on completion */
  notifyOnComplete: boolean
  /** Whether to notify on error */
  notifyOnError: boolean
  /** Whether to auto-retry on failure */
  autoRetry: boolean
  /** Maximum retry attempts */
  maxRetries: number
  /** Retry delay in milliseconds */
  retryDelay: number
  /** Whether to persist state for recovery */
  persistState: boolean
  /** Execution timeout in milliseconds */
  timeout?: number
  /** Maximum concurrent sub-agents */
  maxConcurrentSubAgents: number
  /** Provider configuration */
  provider?: ProviderName
  /** Model configuration */
  model?: string
  /** Temperature */
  temperature?: number
  /** System prompt */
  systemPrompt?: string
  /** Available tools */
  tools?: string[]
  /** Custom tool definitions */
  customTools?: Record<string, AgentTool>
  /** Maximum steps */
  maxSteps?: number
  /** Enable planning mode */
  enablePlanning?: boolean
  /** Auto-approve tool calls */
  autoApproveTools?: boolean
  /** Tools that require manual approval */
  requireApprovalFor?: string[]
  /** Enable Skills integration */
  enableSkills?: boolean
  /** Active skill IDs to use */
  activeSkillIds?: string[]
  /** Enable RAG (Retrieval Augmented Generation) */
  enableRAG?: boolean
  /** RAG collection ID to use */
  ragCollectionId?: string
  /** Enable MCP tools integration */
  enableMcpTools?: boolean
  /** MCP server IDs to use */
  mcpServerIds?: string[]
  /** Enable team delegation for complex tasks */
  enableTeamDelegation?: boolean
  /** Team template ID to use for delegation */
  teamTemplateId?: string
  /** Team config overrides for delegation */
  teamConfig?: Record<string, unknown>
}

/**
 * Background agent log entry
 */
export interface BackgroundAgentLog {
  id: string
  timestamp: Date
  level: "debug" | "info" | "warn" | "error"
  message: string
  source: "agent" | "sub-agent" | "tool" | "mcp" | "system"
  sourceId?: string
  data?: unknown
  stepNumber?: number
  /** MCP server ID if source is 'mcp' or 'tool' from MCP */
  mcpServerId?: string
  /** MCP server name for display */
  mcpServerName?: string
}

/**
 * Background agent step
 */
export interface BackgroundAgentStep {
  id: string
  stepNumber: number
  type: "thinking" | "tool_call" | "sub_agent" | "response"
  status: "pending" | "running" | "completed" | "failed" | "skipped"
  title: string
  description?: string
  response?: string
  toolCalls?: ToolCall[]
  subAgentId?: string
  startedAt?: Date
  completedAt?: Date
  duration?: number
  error?: string
  output?: unknown
}

/**
 * Background agent execution state
 */
export interface BackgroundAgentExecutionState {
  currentStep: number
  totalSteps: number
  currentPhase: "planning" | "executing" | "summarizing" | "completed"
  activeSubAgents: string[]
  completedSubAgents: string[]
  failedSubAgents: string[]
  pendingApprovals: string[]
  lastActivity: Date
  pausedAt?: Date
  resumedAt?: Date
}

/**
 * Background agent result
 */
export interface BackgroundAgentResult {
  /** Whether execution was successful */
  success: boolean
  /** Final response text */
  finalResponse: string
  /** Execution steps */
  steps: BackgroundAgentStep[]
  /** Total steps executed */
  totalSteps: number
  /** Execution duration in milliseconds */
  duration: number
  /** Sub-agent results */
  subAgentResults?: SubAgentOrchestrationResult
  /** Tool call results */
  toolResults?: Array<{
    toolCallId: string
    toolName: string
    result: unknown
  }>
  /** Structured output data */
  output?: Record<string, unknown>
  /** Error message if failed */
  error?: string
  /** Token usage statistics */
  tokenUsage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
  /** Retry count */
  retryCount: number
}

/**
 * Background agent definition
 */
export interface BackgroundAgent {
  /** Unique identifier */
  id: string
  /** Associated session ID */
  sessionId: string
  /** Human-readable name */
  name: string
  /** Description of the agent's purpose */
  description?: string
  /** Task to execute */
  task: string
  /** Current status */
  status: BackgroundAgentStatus
  /** Progress percentage (0-100) */
  progress: number
  /** Configuration */
  config: BackgroundAgentConfig
  /** Execution state */
  executionState: BackgroundAgentExecutionState
  /** Sub-agents spawned by this agent */
  subAgents: SubAgent[]
  /** Execution steps */
  steps: BackgroundAgentStep[]
  /** Execution logs */
  logs: BackgroundAgentLog[]
  /** Notifications */
  notifications: BackgroundAgentNotification[]
  /** Execution result */
  result?: BackgroundAgentResult
  /** Creation timestamp */
  createdAt: Date
  /** Queue timestamp */
  queuedAt?: Date
  /** Start timestamp */
  startedAt?: Date
  /** Completion timestamp */
  completedAt?: Date
  /** Error message if failed */
  error?: string
  /** Retry count */
  retryCount: number
  /** Priority in queue */
  priority: number
  /** Tags for categorization */
  tags?: string[]
  /** Metadata */
  metadata?: Record<string, unknown>
}

/**
 * Background agent queue item
 */
export interface BackgroundAgentQueueItem {
  agentId: string
  priority: number
  queuedAt: Date
  estimatedStartTime?: Date
  estimatedDuration?: number
}

/**
 * Background agent queue state
 */
export interface BackgroundAgentQueueState {
  items: BackgroundAgentQueueItem[]
  maxConcurrent: number
  currentlyRunning: number
  isPaused: boolean
}

/**
 * Input for creating a background agent
 */
export interface CreateBackgroundAgentInput {
  /** Optional identifier (used when syncing with external manager state) */
  id?: string
  sessionId: string
  name: string
  description?: string
  task: string
  config?: Partial<BackgroundAgentConfig>
  priority?: number
  tags?: string[]
  metadata?: Record<string, unknown>
}

/**
 * Input for updating a background agent
 */
export interface UpdateBackgroundAgentInput {
  name?: string
  description?: string
  task?: string
  config?: Partial<BackgroundAgentConfig>
  priority?: number
  tags?: string[]
  metadata?: Record<string, unknown>
}

/**
 * Background agent execution options
 */
export interface BackgroundAgentExecutionOptions {
  /** Callback when agent starts */
  onStart?: (agent: BackgroundAgent) => void
  /** Callback for each step */
  onStep?: (agent: BackgroundAgent, step: BackgroundAgentStep) => void
  /** Callback when agent completes */
  onComplete?: (agent: BackgroundAgent, result: BackgroundAgentResult) => void
  /** Callback when agent fails */
  onError?: (agent: BackgroundAgent, error: string) => void
  /** Callback for progress updates */
  onProgress?: (agent: BackgroundAgent, progress: number) => void
  /** Callback for log entries */
  onLog?: (agent: BackgroundAgent, log: BackgroundAgentLog) => void
  /** Callback for notifications */
  onNotification?: (agent: BackgroundAgent, notification: BackgroundAgentNotification) => void
  /** Callback when sub-agent is created */
  onSubAgentCreate?: (agent: BackgroundAgent, subAgent: SubAgent) => void
  /** Callback when sub-agent completes */
  onSubAgentComplete?: (agent: BackgroundAgent, subAgent: SubAgent, result: SubAgentResult) => void
  /** Callback for tool calls */
  onToolCall?: (agent: BackgroundAgent, toolCall: ToolCall) => void
  /** Callback for tool results */
  onToolResult?: (agent: BackgroundAgent, toolCall: ToolCall) => void
  /** Callback when approval is required */
  onApprovalRequired?: (agent: BackgroundAgent, toolCall: ToolCall) => Promise<boolean>
  /** Callback when agent is paused */
  onPause?: (agent: BackgroundAgent) => void
  /** Callback when agent is resumed */
  onResume?: (agent: BackgroundAgent) => void
  /** Callback when agent is cancelled */
  onCancel?: (agent: BackgroundAgent) => void
}

/**
 * Background agent manager state
 */
export interface BackgroundAgentManagerState {
  agents: Record<string, BackgroundAgent>
  queue: BackgroundAgentQueueState
  activeAgentIds: string[]
  pausedAgentIds: string[]
  completedAgentIds: string[]
  failedAgentIds: string[]
  totalNotifications: number
  unreadNotifications: number
}

/**
 * Default background agent configuration
 */
export const DEFAULT_BACKGROUND_AGENT_CONFIG: BackgroundAgentConfig = {
  runInBackground: true,
  notifyOnProgress: false,
  notifyOnComplete: true,
  notifyOnError: true,
  autoRetry: true,
  maxRetries: 3,
  retryDelay: 2000,
  persistState: true,
  timeout: 600000, // 10 minutes
  maxConcurrentSubAgents: 3,
  maxSteps: 20,
  enablePlanning: true,
  autoApproveTools: false,
  requireApprovalFor: [],
}

/**
 * Background agent status display configuration.
 *
 * `labelKey` is an i18n key under the `agentStatus` namespace; UI consumers
 * resolve it via `useTranslations("agentStatus")(labelKey)`.
 */
export const BACKGROUND_AGENT_STATUS_CONFIG: Record<
  BackgroundAgentStatus,
  {
    labelKey: string
    color: string
    icon: string
    animate?: boolean
  }
> = {
  idle: { labelKey: "idle", color: "text-muted-foreground", icon: "Circle" },
  queued: { labelKey: "queued", color: "text-blue-500", icon: "Clock" },
  initializing: {
    labelKey: "initializing",
    color: "text-blue-500",
    icon: "Loader2",
    animate: true,
  },
  running: { labelKey: "running", color: "text-primary", icon: "Loader2", animate: true },
  paused: { labelKey: "paused", color: "text-yellow-500", icon: "Pause" },
  waiting: { labelKey: "waiting", color: "text-orange-500", icon: "AlertCircle" },
  completed: { labelKey: "completed", color: "text-green-500", icon: "CheckCircle" },
  failed: { labelKey: "failed", color: "text-destructive", icon: "XCircle" },
  cancelled: { labelKey: "cancelled", color: "text-orange-500", icon: "Ban" },
  timeout: { labelKey: "timeout", color: "text-red-500", icon: "AlertTriangle" },
}

/**
 * Serialize background agent for persistence
 */
export function serializeBackgroundAgent(agent: BackgroundAgent): string {
  return JSON.stringify({
    ...agent,
    createdAt: agent.createdAt.toISOString(),
    queuedAt: agent.queuedAt?.toISOString(),
    startedAt: agent.startedAt?.toISOString(),
    completedAt: agent.completedAt?.toISOString(),
    executionState: {
      ...agent.executionState,
      lastActivity: agent.executionState.lastActivity.toISOString(),
      pausedAt: agent.executionState.pausedAt?.toISOString(),
      resumedAt: agent.executionState.resumedAt?.toISOString(),
    },
    logs: agent.logs.map((log) => ({
      ...log,
      timestamp: log.timestamp.toISOString(),
    })),
    notifications: agent.notifications.map((n) => ({
      ...n,
      timestamp: n.timestamp.toISOString(),
    })),
    steps: agent.steps.map((step) => ({
      ...step,
      startedAt: step.startedAt?.toISOString(),
      completedAt: step.completedAt?.toISOString(),
    })),
    subAgents: agent.subAgents.map((sa) => ({
      ...sa,
      createdAt: sa.createdAt.toISOString(),
      startedAt: sa.startedAt?.toISOString(),
      completedAt: sa.completedAt?.toISOString(),
      logs: sa.logs.map((log) => ({
        ...log,
        timestamp: log.timestamp.toISOString(),
      })),
    })),
  })
}

/**
 * Deserialize background agent from persistence
 */
export function deserializeBackgroundAgent(data: string): BackgroundAgent {
  const parsed = JSON.parse(data)
  return {
    ...parsed,
    createdAt: new Date(parsed.createdAt),
    queuedAt: parsed.queuedAt ? new Date(parsed.queuedAt) : undefined,
    startedAt: parsed.startedAt ? new Date(parsed.startedAt) : undefined,
    completedAt: parsed.completedAt ? new Date(parsed.completedAt) : undefined,
    executionState: {
      ...parsed.executionState,
      lastActivity: new Date(parsed.executionState.lastActivity),
      pausedAt: parsed.executionState.pausedAt
        ? new Date(parsed.executionState.pausedAt)
        : undefined,
      resumedAt: parsed.executionState.resumedAt
        ? new Date(parsed.executionState.resumedAt)
        : undefined,
    },
    logs: parsed.logs.map((log: Record<string, unknown>) => ({
      ...log,
      timestamp: new Date(log.timestamp as string),
    })),
    notifications: parsed.notifications.map((n: Record<string, unknown>) => ({
      ...n,
      timestamp: new Date(n.timestamp as string),
    })),
    steps: parsed.steps.map((step: Record<string, unknown>) => ({
      ...step,
      startedAt: step.startedAt ? new Date(step.startedAt as string) : undefined,
      completedAt: step.completedAt ? new Date(step.completedAt as string) : undefined,
    })),
    subAgents: parsed.subAgents.map((sa: Record<string, unknown>) => ({
      ...sa,
      createdAt: new Date(sa.createdAt as string),
      startedAt: sa.startedAt ? new Date(sa.startedAt as string) : undefined,
      completedAt: sa.completedAt ? new Date(sa.completedAt as string) : undefined,
      logs: (sa.logs as Array<Record<string, unknown>>).map((log) => ({
        ...log,
        timestamp: new Date(log.timestamp as string),
      })),
    })),
  }
}
