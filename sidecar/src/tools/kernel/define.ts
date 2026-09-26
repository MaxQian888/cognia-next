// The shape of a built-in tool definition: what the registry assembles, the
// middleware wraps, and each rail's adapter turns into its own tool format.
// It is the Claude Agent SDK's `SdkMcpToolDefinition` shape, which the Claude
// Agent SDK rail registers as is.

import type { z } from "zod"

/** The parsed arguments a handler receives for a zod raw shape (defaults applied). */
export type ToolArgs<S extends z.ZodRawShape> = z.output<z.ZodObject<S>>

/** The second argument every handler receives. */
export interface ToolHandlerExtra {
  /** Aborted when the user interrupts the call; long-running handlers stop on it. */
  signal?: AbortSignal | undefined
  [field: string]: unknown
}

export interface ToolDefinition {
  name: string
  description?: string | undefined
  /** A zod raw shape (or a zod object); every rail derives its schema from it. */
  inputSchema?: unknown
  annotations?: Record<string, unknown> | undefined
  _meta?: Record<string, unknown> | undefined
  /**
   * Runs the call and resolves to an MCP `CallToolResult`. A method, so a
   * handler typed for its own parsed arguments still fits the registry.
   */
  handler(args: unknown, extra?: ToolHandlerExtra): unknown
}

/**
 * A definition after middleware replaced its handler: every other field of
 * `D` is kept, and the handler is the generic one.
 */
export type WrappedToolDefinition<D extends ToolDefinition> = Omit<D, "handler"> &
  Pick<ToolDefinition, "handler">
