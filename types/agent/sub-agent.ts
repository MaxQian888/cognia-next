/**
 * SubAgent Type Definitions
 * Defines types for sub-agents that can be spawned by parent agents
 */

import type { AgentTool, ToolCall } from "@/lib/ai/agent"
import type { ProviderName } from "@cognia/provider-types/provider"

/**
 * SubAgent token usage statistics
 */
export interface SubAgentTokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

/**
 * Cancellation token for aborting SubAgent execution
 */
export interface CancellationToken {
  /** Signal from AbortController */
  signal: AbortSignal
  /** Check if cancellation was requested */
  isCancelled: boolean
  /** Request cancellation */
  cancel: () => void
  /** Throw if cancelled */
  throwIfCancelled: () => void
}

export type SubAgentMessageRole = "user" | "assistant" | "system"
export type SubAgentSourceType = "web" | "tool" | "memory" | "file" | "quote" | "other"

export interface SubAgentSource {
  title: string
  url?: string
  snippet?: string
  toolName?: string
  sourceType?: SubAgentSourceType
  subAgentId?: string
}

/**
 * Create a new CancellationToken
 */
export function createCancellationToken(): CancellationToken {
  const controller = new AbortController()
  let cancelled = false

  return {
    signal: controller.signal,
    get isCancelled() {
      return cancelled
    },
    cancel() {
      cancelled = true
      controller.abort()
    },
    throwIfCancelled() {
      if (cancelled) {
        throw new Error("Operation cancelled")
      }
    },
  }
}

/**
 * SubAgent execution status
 */
export type SubAgentStatus =
  | "pending" // Waiting to be started
  | "queued" // In execution queue
  | "running" // Currently executing
  | "waiting" // Waiting for dependency or approval
  | "completed" // Successfully completed
  | "failed" // Execution failed
  | "cancelled" // Cancelled by user or parent
  | "timeout" // Execution timed out
  | "rejected" // Dispatch refused by a nesting guard (max-depth / cycle)

/**
 * SubAgent priority levels
 */
export type SubAgentPriority = "critical" | "high" | "normal" | "low" | "background"

/**
 * SubAgent execution mode
 */
export type SubAgentExecutionMode =
  | "sequential" // Execute one after another
  | "parallel" // Execute simultaneously
  | "conditional" // Execute based on conditions

/**
 * SubAgent configuration
 */
export interface SubAgentConfig {
  /** Custom system prompt for the sub-agent */
  systemPrompt?: string
  /** Available tools for this sub-agent */
  tools?: string[]
  /** Custom tool definitions */
  customTools?: Record<string, AgentTool>
  /** Maximum execution steps */
  maxSteps?: number
  /** Execution timeout in milliseconds */
  timeout?: number
  /** Execution priority */
  priority?: SubAgentPriority
  /** Whether to inherit parent agent's context */
  inheritParentContext?: boolean
  /** Whether to share results with sibling sub-agents */
  shareResults?: boolean
  /** Provider override */
  provider?: ProviderName
  /** Model override */
  model?: string
  /** Temperature override */
  temperature?: number
  /** Retry configuration */
  retryConfig?: {
    maxRetries: number
    retryDelay: number
    exponentialBackoff: boolean
  }
  /** Dependencies - IDs of sub-agents that must complete first */
  dependencies?: string[]
  /** Condition for conditional execution */
  condition?: string | ((context: SubAgentContext) => boolean)

  // === Context Isolation (Claude Best Practice) ===
  // Prevent context pollution by summarizing results before returning to parent.

  /** Summarize results before returning to parent agent */
  summarizeResults?: boolean
  /** Maximum tokens for summarized result */
  maxResultTokens?: number
  /** Custom summarization prompt */
  summarizationPrompt?: string

  // === External Agent Delegation ===
  // Support for executing sub-agents on external agents (ACP, A2A, etc.)

  /** Execute this sub-agent on an external agent */
  useExternalAgent?: boolean
  /** External agent ID to use for execution */
  externalAgentId?: string
  /** Permission mode for external agent execution */
  externalAgentPermissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan"

  // === Nested Dispatch (depth-N subagents) ===
  /** Opt this sub-agent into dispatching its own sub-agents when it runs. */
  allowNesting?: boolean
  /** Per-sub-agent override of the max nesting level (combined with the app cap via `min`). */
  maxNestingDepth?: number
}

/**
 * SubAgent execution context
 */
export interface SubAgentContext {
  /** Parent agent ID */
  parentAgentId: string
  /** Session ID */
  sessionId: string
  /** Shared context from parent */
  parentContext?: Record<string, unknown>
  /** Results from sibling sub-agents */
  siblingResults?: Record<string, SubAgentResult>
  /** Global variables */
  variables?: Record<string, unknown>
  /** Execution start time */
  startTime: Date
  /** Current step number */
  currentStep: number
}

/**
 * SubAgent execution step
 */
export interface SubAgentStep {
  stepNumber: number
  response: string
  toolCalls: ToolCall[]
  timestamp: Date
  duration?: number
  tokenUsage?: SubAgentTokenUsage
}

/**
 * SubAgent execution result
 */
export interface SubAgentResult {
  /** Whether execution was successful */
  success: boolean
  /** Final response text */
  finalResponse: string
  /** Execution steps */
  steps: SubAgentStep[]
  /** Total steps executed */
  totalSteps: number
  /** Execution duration in milliseconds */
  duration: number
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
  tokenUsage?: SubAgentTokenUsage
  /** Traceable sources referenced during execution */
  sources?: SubAgentSource[]
}

/**
 * SubAgent log entry
 */
export interface SubAgentLog {
  timestamp: Date
  level: "debug" | "info" | "warn" | "error"
  message: string
  data?: unknown
  stepNumber?: number
}

export interface SubAgentThreadMessage {
  id: string
  role: SubAgentMessageRole
  content: string
  createdAt: Date
  runId?: string
  status?: "pending" | "completed" | "failed"
  sources?: SubAgentSource[]
}

export interface SubAgentRunSnapshot {
  id: string
  task: string
  status: SubAgentStatus
  startedAt: Date
  completedAt?: Date
  result: SubAgentResult
}

/**
 * SubAgent definition
 */
export interface SubAgent {
  /** Unique identifier */
  id: string
  /** Parent agent ID */
  parentAgentId: string
  /** Human-readable name */
  name: string
  /** Description of the sub-agent's purpose */
  description: string
  /** Task to execute */
  task: string
  /** Initial task used to seed the threaded conversation */
  initialTask: string
  /** Thread identifier for this sub-agent conversation */
  threadId: string
  /** Current status */
  status: SubAgentStatus
  /** Configuration */
  config: SubAgentConfig
  /** Execution context */
  context?: SubAgentContext
  /** Execution result */
  result?: SubAgentResult
  /** Threaded message history for continuing the sub-agent */
  messages: SubAgentThreadMessage[]
  /** Aggregated sources discovered across runs */
  sources: SubAgentSource[]
  /** Latest run snapshot for quick resume and inspection */
  lastRun?: SubAgentRunSnapshot
  /** Execution logs */
  logs: SubAgentLog[]
  /** Progress percentage (0-100) */
  progress: number
  /**
   * Number of tool calls the run has made so far — an honest, monotonic
   * activity counter surfaced in the chat `SubagentPart` ("N tools"). Unlike
   * {@link progress} (a derived pseudo-percentage), this is the raw count.
   */
  toolUses?: number
  /** Creation timestamp */
  createdAt: Date
  /** Last activity timestamp for sorting/selecting live threads */
  lastActivityAt: Date
  /** Start timestamp */
  startedAt?: Date
  /** Completion timestamp */
  completedAt?: Date
  /** Error message if failed */
  error?: string
  /** Retry count */
  retryCount: number
  /** Order in execution sequence */
  order: number
  /** Tags for categorization */
  tags?: string[]

  // === Nested Dispatch tree (depth-N subagents) ===
  /** Nesting level this run executes at. Top-level (dispatched by chat) = 1. */
  depth?: number
  /**
   * Id of the spawning sub-agent RUN (the tree edge) — distinct from
   * {@link parentAgentId} which is the parent agent identity. Undefined for a
   * run dispatched directly by the top-level chat.
   */
  parentSubagentId?: string
  /** Set when this dispatch was refused by a nesting guard. */
  rejection?: { reason: "max-depth" | "cycle"; message: string; attemptedDepth?: number }
  /** True while the run is detached (backgrounded) and awaiting a later result. */
  backgrounded?: boolean
}

/**
 * SubAgent group for organizing related sub-agents
 */
export interface SubAgentGroup {
  id: string
  name: string
  description?: string
  executionMode: SubAgentExecutionMode
  subAgentIds: string[]
  maxConcurrency?: number
  status: SubAgentStatus
  progress: number
  createdAt: Date
  startedAt?: Date
  completedAt?: Date
}

/**
 * Input for creating a new sub-agent
 */
export interface CreateSubAgentInput {
  parentAgentId: string
  name: string
  description?: string
  task: string
  config?: Partial<SubAgentConfig>
  order?: number
  tags?: string[]
}

/**
 * Input for updating a sub-agent
 */
export interface UpdateSubAgentInput {
  name?: string
  description?: string
  task?: string
  config?: Partial<SubAgentConfig>
  status?: SubAgentStatus
  tags?: string[]
}

/**
 * SubAgent execution options
 */
export interface SubAgentExecutionOptions {
  /** Callback when sub-agent starts */
  onStart?: (subAgent: SubAgent) => void
  /** Callback for each step */
  onStep?: (subAgent: SubAgent, step: SubAgentStep) => void
  /** Callback when sub-agent completes */
  onComplete?: (subAgent: SubAgent, result: SubAgentResult) => void
  /** Callback when sub-agent fails */
  onError?: (subAgent: SubAgent, error: string) => void
  /** Callback for progress updates */
  onProgress?: (subAgent: SubAgent, progress: number) => void
  /** Callback for log entries */
  onLog?: (subAgent: SubAgent, log: SubAgentLog) => void
  /** Callback for tool calls */
  onToolCall?: (subAgent: SubAgent, toolCall: ToolCall) => void
  /** Callback for tool results */
  onToolResult?: (subAgent: SubAgent, toolCall: ToolCall) => void
}

/**
 * SubAgent orchestration result
 */
export interface SubAgentOrchestrationResult {
  /** Whether all sub-agents completed successfully */
  success: boolean
  /** Results from all sub-agents */
  results: Record<string, SubAgentResult>
  /** Aggregated final response */
  aggregatedResponse?: string
  /** Total execution duration */
  totalDuration: number
  /** Total token usage */
  totalTokenUsage?: SubAgentTokenUsage
  /** Errors from failed sub-agents */
  errors?: Record<string, string>
}

/**
 * Default sub-agent configuration
 */
export const DEFAULT_SUB_AGENT_CONFIG: SubAgentConfig = {
  maxSteps: 10,
  timeout: 300000, // 5 minutes
  priority: "normal",
  inheritParentContext: true,
  shareResults: true,
  retryConfig: {
    maxRetries: 2,
    retryDelay: 1000,
    exponentialBackoff: true,
  },
}

/**
 * SubAgent status display configuration.
 *
 * `labelKey` is an i18n key under the `agentStatus` namespace; UI consumers
 * resolve it via `useTranslations("agentStatus")(labelKey)`.
 */
export const SUB_AGENT_STATUS_CONFIG: Record<
  SubAgentStatus,
  {
    labelKey: string
    color: string
    icon: string
  }
> = {
  pending: { labelKey: "pending", color: "text-muted-foreground", icon: "Circle" },
  queued: { labelKey: "queued", color: "text-blue-500", icon: "Clock" },
  running: { labelKey: "running", color: "text-primary", icon: "Loader2" },
  waiting: { labelKey: "waiting", color: "text-yellow-500", icon: "Pause" },
  completed: { labelKey: "completed", color: "text-green-500", icon: "CheckCircle" },
  failed: { labelKey: "failed", color: "text-destructive", icon: "XCircle" },
  cancelled: { labelKey: "cancelled", color: "text-orange-500", icon: "Ban" },
  timeout: { labelKey: "timeout", color: "text-red-500", icon: "AlertTriangle" },
  rejected: { labelKey: "rejected", color: "text-destructive", icon: "ShieldAlert" },
}

/**
 * SubAgent priority display configuration.
 *
 * `labelKey` is under the `agentPriority` namespace.
 */
export const SUB_AGENT_PRIORITY_CONFIG: Record<
  SubAgentPriority,
  {
    labelKey: string
    color: string
    weight: number
  }
> = {
  critical: { labelKey: "critical", color: "text-red-500", weight: 5 },
  high: { labelKey: "high", color: "text-orange-500", weight: 4 },
  normal: { labelKey: "normal", color: "text-blue-500", weight: 3 },
  low: { labelKey: "low", color: "text-muted-foreground", weight: 2 },
  background: { labelKey: "background", color: "text-gray-400", weight: 1 },
}

/**
 * SubAgent template for reusable configurations
 */
export interface SubAgentTemplate {
  /** Unique template ID */
  id: string
  /** Template name */
  name: string
  /** Template description */
  description: string
  /** Template category */
  category: "research" | "coding" | "writing" | "analysis" | "general"
  /** Default task template (with {{placeholders}}) */
  taskTemplate: string
  /** Default configuration */
  config: Partial<SubAgentConfig>
  /** Required variables for the template */
  variables?: Array<{
    name: string
    description: string
    required: boolean
    defaultValue?: string
  }>
  /** Icon name for UI */
  icon?: string
  /** Whether this is a built-in template */
  isBuiltIn?: boolean
  /** Creation timestamp */
  createdAt?: Date
}

/**
 * SubAgent execution metrics for analytics
 */
export interface SubAgentMetrics {
  /** Total execution count */
  executionCount: number
  /** Successful execution count */
  successCount: number
  /** Failed execution count */
  failureCount: number
  /** Average execution duration (ms) */
  avgDuration: number
  /** Total token usage */
  totalTokens: number
  /** Average tokens per execution */
  avgTokensPerExecution: number
  /** Last execution timestamp */
  lastExecutedAt?: Date
}

/**
 * Built-in SubAgent templates
 */
export const BUILT_IN_SUBAGENT_TEMPLATES: SubAgentTemplate[] = [
  {
    id: "research-web",
    name: "Web Research",
    description: "Search and analyze web content for a specific topic",
    category: "research",
    taskTemplate: "Research the following topic and provide a comprehensive summary: {{topic}}",
    config: {
      maxSteps: 8,
      timeout: 180000,
      priority: "normal",
    },
    variables: [{ name: "topic", description: "Research topic", required: true }],
    icon: "Search",
    isBuiltIn: true,
  },
  {
    id: "code-review",
    name: "Code Review",
    description: "Review code for bugs, performance issues, and best practices",
    category: "coding",
    taskTemplate:
      "Review the following code and provide detailed feedback on bugs, performance, and best practices:\n\n{{code}}",
    config: {
      maxSteps: 5,
      timeout: 120000,
      priority: "high",
    },
    variables: [{ name: "code", description: "Code to review", required: true }],
    icon: "Code",
    isBuiltIn: true,
  },
  {
    id: "content-writer",
    name: "Content Writer",
    description: "Generate written content based on specifications",
    category: "writing",
    taskTemplate: "Write {{contentType}} about {{topic}}. Requirements: {{requirements}}",
    config: {
      maxSteps: 6,
      timeout: 150000,
      priority: "normal",
      temperature: 0.8,
    },
    variables: [
      {
        name: "contentType",
        description: "Type of content (article, blog post, etc.)",
        required: true,
      },
      { name: "topic", description: "Topic to write about", required: true },
      {
        name: "requirements",
        description: "Additional requirements",
        required: false,
        defaultValue: "None",
      },
    ],
    icon: "FileText",
    isBuiltIn: true,
  },
  {
    id: "data-analyzer",
    name: "Data Analyzer",
    description: "Analyze data and extract insights",
    category: "analysis",
    taskTemplate:
      "Analyze the following data and provide key insights:\n\n{{data}}\n\nFocus on: {{focusAreas}}",
    config: {
      maxSteps: 10,
      timeout: 240000,
      priority: "normal",
    },
    variables: [
      { name: "data", description: "Data to analyze", required: true },
      {
        name: "focusAreas",
        description: "Areas to focus on",
        required: false,
        defaultValue: "trends, patterns, anomalies",
      },
    ],
    icon: "BarChart",
    isBuiltIn: true,
  },
]
