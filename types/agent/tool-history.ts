/**
 * Tool History Type Definitions
 *
 * Types for tracking tool/skill call history and usage analytics
 * to enable intelligent prompt optimization and quick access.
 */

/**
 * Type of tool being tracked
 */
export type ToolType = "mcp" | "skill"

/**
 * Result status of a tool call
 */
export type ToolCallResultStatus = "success" | "error" | "cancelled" | "pending"

/**
 * Individual tool call record
 */
export interface ToolCallRecord {
  /** Unique identifier for this call */
  id: string
  /** Composite tool identifier (MCP: serverId:toolName, Skill: skill:skillId) */
  toolId: string
  /** Type of tool */
  toolType: ToolType
  /** Display name of the tool */
  toolName: string
  /** MCP server ID (for MCP tools) */
  serverId?: string
  /** MCP server display name */
  serverName?: string
  /** Skill ID (for skills) */
  skillId?: string
  /** Arguments passed to the tool */
  args?: Record<string, unknown>
  /** User prompt that triggered this call */
  prompt: string
  /** Truncated/summarized prompt for display */
  promptSummary?: string
  /** Result status */
  result: ToolCallResultStatus
  /** Error message if failed */
  errorMessage?: string
  /** Tool output/response (truncated for storage) */
  output?: string
  /** When the call was made */
  calledAt: Date
  /** Duration in milliseconds */
  duration?: number
  /** Session ID where call was made */
  sessionId?: string
  /** Chat ID where call was made */
  chatId?: string
  /** Tags for categorization */
  tags?: string[]
}

/**
 * Aggregated usage statistics for a tool
 */
export interface ToolUsageStats {
  /** Composite tool identifier */
  toolId: string
  /** Type of tool */
  toolType: ToolType
  /** Display name */
  toolName: string
  /** Server ID for MCP tools */
  serverId?: string
  /** Server name for MCP tools */
  serverName?: string
  /** Total number of calls */
  totalCalls: number
  /** Number of successful calls */
  successCalls: number
  /** Number of failed calls */
  errorCalls: number
  /** Last time this tool was used */
  lastUsedAt?: Date
  /** Average call duration in ms */
  avgDuration: number
  /** Common prompts that trigger this tool (top 5) */
  frequentPrompts: FrequentPrompt[]
  /** Whether user has marked as favorite */
  isFavorite: boolean
  /** Whether tool is pinned to top */
  isPinned: boolean
  /** Custom display order (lower = higher priority) */
  displayOrder?: number
}

/**
 * Frequently used prompt pattern
 */
export interface FrequentPrompt {
  /** The prompt text (may be truncated) */
  prompt: string
  /** Number of times used */
  count: number
  /** Last time this prompt was used */
  lastUsedAt: Date
  /** Success rate when using this prompt */
  successRate: number
}

/**
 * Prompt optimization suggestion based on history
 */
export interface PromptOptimizationSuggestion {
  /** Tool this suggestion is for */
  toolId: string
  /** Suggested prompt text */
  suggestedPrompt: string
  /** Confidence score (0-1) */
  confidence: number
  /** Number of historical calls this is based on */
  basedOnCalls: number
  /** Success rate of similar prompts */
  successRate: number
  /** Why this suggestion was made */
  reason: "frequent" | "successful" | "similar" | "recent"
}

/**
 * Tool recommendation based on context
 */
export interface ToolRecommendation {
  /** Recommended tool */
  toolId: string
  /** Tool type */
  toolType: ToolType
  /** Tool name */
  toolName: string
  /** Server info for MCP */
  serverId?: string
  serverName?: string
  /** Recommendation score (0-1) */
  score: number
  /** Reason for recommendation */
  reason: "recent" | "frequent" | "context_match" | "similar_prompt"
  /** Sample prompt to use */
  samplePrompt?: string
}

/**
 * Settings for tool history feature
 */
export interface ToolHistorySettings {
  /** Enable history tracking */
  enabled: boolean
  /** Maximum history records to keep */
  maxRecords: number
  /** Days to keep history before auto-cleanup */
  retentionDays: number
  /** Show recent tools in mention popover */
  showRecentInPopover: boolean
  /** Number of recent tools to show */
  recentToolsCount: number
  /** Enable prompt suggestions */
  enablePromptSuggestions: boolean
  /** Show usage badges on tools */
  showUsageBadges: boolean
}

/**
 * Default settings
 */
export const DEFAULT_TOOL_HISTORY_SETTINGS: ToolHistorySettings = {
  enabled: true,
  maxRecords: 1000,
  retentionDays: 90,
  showRecentInPopover: true,
  recentToolsCount: 5,
  enablePromptSuggestions: true,
  showUsageBadges: true,
}

/**
 * Filter options for querying history
 */
export interface ToolHistoryFilter {
  /** Filter by tool type */
  toolType?: ToolType
  /** Filter by specific tool ID */
  toolId?: string
  /** Filter by server ID (MCP) */
  serverId?: string
  /** Filter by result status */
  result?: ToolCallResultStatus
  /** Filter by date range - start */
  fromDate?: Date
  /** Filter by date range - end */
  toDate?: Date
  /** Filter by session */
  sessionId?: string
  /** Filter by chat */
  chatId?: string
  /** Search in prompts */
  searchQuery?: string
  /** Limit results */
  limit?: number
  /** Offset for pagination */
  offset?: number
}

/**
 * Sort options for tool lists
 */
export type ToolSortOption =
  | "recent" // Most recently used first
  | "frequent" // Most frequently used first
  | "alphabetical" // A-Z by name
  | "success_rate" // Highest success rate first
  | "custom" // User-defined order (pinned first, then favorites)

/**
 * Helper to create a tool ID
 */
export function createToolId(type: ToolType, identifier: string, serverId?: string): string {
  if (type === "mcp" && serverId) {
    return `mcp:${serverId}:${identifier}`
  }
  return `${type}:${identifier}`
}

/**
 * Parse a tool ID back to components
 */
export function parseToolId(
  toolId: string
): { type: ToolType; identifier: string; serverId?: string } | null {
  const mcpMatch = toolId.match(/^mcp:([^:]+):(.+)$/)
  if (mcpMatch) {
    return { type: "mcp", serverId: mcpMatch[1], identifier: mcpMatch[2] }
  }

  const skillMatch = toolId.match(/^skill:(.+)$/)
  if (skillMatch) {
    return { type: "skill", identifier: skillMatch[1] }
  }

  return null
}

// Note: ToolCallResult alias removed to avoid conflict with mcp/mcp.ts
// Use ToolCallResultStatus instead

/**
 * Truncate prompt for storage/display
 */
export function truncatePrompt(prompt: string, maxLength: number = 200): string {
  if (prompt.length <= maxLength) return prompt
  return prompt.slice(0, maxLength - 3) + "..."
}
