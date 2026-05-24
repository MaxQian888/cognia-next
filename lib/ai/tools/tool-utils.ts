/**
 * Tool Utilities - Enhanced tool calling for AI SDK
 *
 * Provides utilities for creating and managing AI tools:
 * - Tool creation helpers with strict mode
 * - Approval workflow support
 * - Input examples
 * - Tool result handling
 *
 * Based on AI SDK documentation:
 * https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling
 */

import { tool } from "ai"
import { z, type ZodType } from "zod"

// Re-export core tool function
export { tool }

/**
 * Configuration object passed to {@link createTool}.
 */
export interface ToolConfig<TInput extends ZodType, TOutput> {
  /** Tool description for the LLM */
  description: string
  /** Zod schema for input validation */
  inputSchema: TInput
  /** Execute function */
  execute: (input: z.infer<TInput>) => Promise<TOutput>
  /** Enable strict mode for input validation */
  strict?: boolean
  /** Require approval before execution */
  needsApproval?: boolean | ((input: z.infer<TInput>) => Promise<boolean>)
  /** Example inputs to guide the model */
  inputExamples?: Array<{ input: z.infer<TInput> }>
}

/**
 * Create a tool with all options
 */
export function createTool<TInput extends ZodType, TOutput>(
  definition: ToolConfig<TInput, TOutput>
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const toolConfig: any = {
    description: definition.description,
    parameters: definition.inputSchema,
    execute: definition.execute,
  }

  if (definition.strict !== undefined) {
    toolConfig.strict = definition.strict
  }
  if (definition.needsApproval !== undefined) {
    toolConfig.needsApproval = definition.needsApproval
  }
  if (definition.inputExamples) {
    toolConfig.inputExamples = definition.inputExamples
  }

  return tool(toolConfig)
}

/**
 * Tool approval request
 */
export interface ToolApprovalRequest {
  type: "tool-approval-request"
  approvalId: string
  toolCall: {
    toolName: string
    input: unknown
    toolCallId: string
  }
}

/**
 * Tool approval response
 */
export interface ToolApprovalResponse {
  type: "tool-approval-response"
  approvalId: string
  approved: boolean
  reason?: string
}

/**
 * Check if content contains approval requests
 */
export function hasApprovalRequests(content: unknown[]): boolean {
  return content.some(
    (part) =>
      typeof part === "object" &&
      part !== null &&
      "type" in part &&
      part.type === "tool-approval-request"
  )
}

/**
 * Extract approval requests from content
 */
export function extractApprovalRequests(content: unknown[]): ToolApprovalRequest[] {
  return content.filter(
    (part): part is ToolApprovalRequest =>
      typeof part === "object" &&
      part !== null &&
      "type" in part &&
      part.type === "tool-approval-request"
  )
}

/**
 * Create approval responses for all requests
 */
export function createApprovalResponses(
  requests: ToolApprovalRequest[],
  decisions: Map<string, { approved: boolean; reason?: string }>
): ToolApprovalResponse[] {
  return requests.map((request) => {
    const decision = decisions.get(request.approvalId) || {
      approved: false,
      reason: "No decision provided",
    }
    return {
      type: "tool-approval-response" as const,
      approvalId: request.approvalId,
      approved: decision.approved,
      reason: decision.reason,
    }
  })
}

/**
 * Tool category for organization
 */
export type ToolCategory =
  | "search"
  | "data"
  | "communication"
  | "file"
  | "code"
  | "browser"
  | "system"
  | "custom"

/**
 * Tool metadata for registry
 */
export interface ToolMetadata {
  /** Tool name */
  name: string
  /** Tool category */
  category: ToolCategory
  /** Whether the tool is dangerous/sensitive */
  isDangerous?: boolean
  /** Estimated cost per call */
  estimatedCostPerCall?: number
  /** Rate limit (calls per minute) */
  rateLimit?: number
  /** Required permissions */
  requiredPermissions?: string[]
  /**
   * Origin of the tool. `"builtin"` for tools the host registers itself,
   * `"plugin"` for tools contributed by an installed plugin. The plugin
   * runtime sets this — call sites that want to render badges or filter the
   * tool list by origin can read it via `getMetadata(name)`.
   */
  source?: "builtin" | "plugin"
  /**
   * When `source === "plugin"`, the id of the plugin that registered the
   * tool. Set together with `source` so the runtime can bulk-unregister
   * everything a plugin contributed via `unregisterByPlugin(pluginId)`.
   */
  pluginId?: string
}

/**
 * Tool registry for managing multiple tools
 */
export class ToolRegistry {
  private tools = new Map<string, { tool: ReturnType<typeof tool>; metadata: ToolMetadata }>()

  /**
   * Register a tool with metadata
   */
  register<TInput extends ZodType, TOutput>(
    name: string,
    definition: ToolConfig<TInput, TOutput>,
    metadata: Omit<ToolMetadata, "name">
  ) {
    const createdTool = createTool(definition)
    this.tools.set(name, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tool: createdTool as any,
      metadata: { name, ...metadata },
    })
    return this
  }

  /**
   * Get a tool by name
   */
  get(name: string) {
    return this.tools.get(name)?.tool
  }

  /**
   * Get tool metadata
   */
  getMetadata(name: string): ToolMetadata | undefined {
    return this.tools.get(name)?.metadata
  }

  /**
   * Get all tools as an object for AI SDK
   */
  getTools(): Record<string, ReturnType<typeof tool>> {
    const result: Record<string, ReturnType<typeof tool>> = {}
    for (const [name, { tool }] of this.tools) {
      result[name] = tool
    }
    return result
  }

  /**
   * Get tools by category
   */
  getByCategory(category: ToolCategory): Record<string, ReturnType<typeof tool>> {
    const result: Record<string, ReturnType<typeof tool>> = {}
    for (const [name, { tool, metadata }] of this.tools) {
      if (metadata.category === category) {
        result[name] = tool
      }
    }
    return result
  }

  /**
   * Get safe tools (not marked as dangerous)
   */
  getSafeTools(): Record<string, ReturnType<typeof tool>> {
    const result: Record<string, ReturnType<typeof tool>> = {}
    for (const [name, { tool, metadata }] of this.tools) {
      if (!metadata.isDangerous) {
        result[name] = tool
      }
    }
    return result
  }

  /**
   * Check if a tool requires approval
   */
  requiresApproval(name: string): boolean {
    const metadata = this.getMetadata(name)
    return metadata?.isDangerous ?? false
  }

  /**
   * Get all tool names
   */
  getNames(): string[] {
    return Array.from(this.tools.keys())
  }

  /**
   * Get all metadata
   */
  getAllMetadata(): ToolMetadata[] {
    return Array.from(this.tools.values()).map(({ metadata }) => metadata)
  }

  /**
   * Remove a single tool by name. Returns `true` if a tool was actually
   * removed. Used by plugin disable to drop a tool the plugin registered
   * without churning the entire registry.
   */
  unregister(name: string): boolean {
    return this.tools.delete(name)
  }

  /**
   * Remove every tool tagged with `metadata.pluginId === pluginId`. Returns
   * the number of tools removed. Called by the plugin manager during
   * disable / uninstall so a single plugin's contributions all disappear in
   * one shot.
   */
  unregisterByPlugin(pluginId: string): number {
    let removed = 0
    for (const [name, entry] of this.tools) {
      if (entry.metadata.pluginId === pluginId) {
        this.tools.delete(name)
        removed += 1
      }
    }
    return removed
  }
}

/**
 * Common tool schemas
 */
export const CommonSchemas = {
  /** URL input */
  url: z.object({
    url: z.string().url().describe("The URL to process"),
  }),

  /** Search query */
  search: z.object({
    query: z.string().describe("The search query"),
    limit: z.number().optional().describe("Maximum number of results"),
  }),

  /** File path */
  filePath: z.object({
    path: z.string().describe("The file path"),
  }),

  /** Code execution */
  code: z.object({
    code: z.string().describe("The code to execute"),
    language: z
      .enum(["javascript", "typescript", "python", "shell"])
      .describe("Programming language"),
  }),

  /** Location */
  location: z.object({
    location: z.string().describe("The location (city, address, or coordinates)"),
  }),

  /** Date range */
  dateRange: z.object({
    startDate: z.string().describe("Start date in ISO format"),
    endDate: z.string().describe("End date in ISO format"),
  }),
}

/**
 * Create a simple tool from a function
 */
export function simpleTool<TInput extends Record<string, unknown>, TOutput>(
  name: string,
  description: string,
  inputSchema: ZodType<TInput>,
  execute: (input: TInput) => Promise<TOutput>
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const toolConfig: any = {
    description,
    parameters: inputSchema,
    execute,
  }
  return {
    [name]: tool(toolConfig),
  }
}

/**
 * Combine multiple tool objects into one
 */
export function combineTools(
  ...toolObjects: Record<string, ReturnType<typeof tool>>[]
): Record<string, ReturnType<typeof tool>> {
  return Object.assign({}, ...toolObjects)
}

/**
 * Create a tool that wraps another with rate limiting
 */
export function withRateLimit<TInput extends ZodType, TOutput>(
  definition: ToolConfig<TInput, TOutput>,
  options: {
    maxCalls: number
    windowMs: number
  }
) {
  const calls: number[] = []

  return createTool({
    ...definition,
    execute: async (input) => {
      const now = Date.now()
      // Remove old calls outside the window
      while (calls.length > 0 && calls[0] < now - options.windowMs) {
        calls.shift()
      }

      if (calls.length >= options.maxCalls) {
        throw new Error(
          `Rate limit exceeded. Max ${options.maxCalls} calls per ${options.windowMs}ms`
        )
      }

      calls.push(now)
      return definition.execute(input)
    },
  })
}

/**
 * Create a tool that caches results
 */
export function withCache<TInput extends ZodType, TOutput>(
  definition: ToolConfig<TInput, TOutput>,
  options?: {
    ttlMs?: number
    maxSize?: number
    keyFn?: (input: z.infer<TInput>) => string
  }
) {
  const { ttlMs = 60000, maxSize = 100, keyFn = JSON.stringify } = options || {}
  const cache = new Map<string, { value: TOutput; expiry: number }>()

  return createTool({
    ...definition,
    execute: async (input) => {
      const key = keyFn(input)
      const now = Date.now()

      // Check cache
      const cached = cache.get(key)
      if (cached && cached.expiry > now) {
        return cached.value
      }

      // Execute and cache
      const result = await definition.execute(input)

      // Evict if at capacity
      if (cache.size >= maxSize) {
        const firstKey = cache.keys().next().value
        if (firstKey) cache.delete(firstKey)
      }

      cache.set(key, { value: result, expiry: now + ttlMs })
      return result
    },
  })
}

/**
 * Default tool registry singleton
 */
let defaultRegistry: ToolRegistry | null = null

/**
 * Get the default tool registry
 */
export function getDefaultToolRegistry(): ToolRegistry {
  if (!defaultRegistry) {
    defaultRegistry = new ToolRegistry()
  }
  return defaultRegistry
}
