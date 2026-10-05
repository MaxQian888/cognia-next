// The shape of a built-in tool definition: what the registry assembles, the
// middleware wraps, and each rail's adapter turns into its own tool format.
// It belongs to no engine (ADR-0217): the Claude Agent SDK rail translates it
// into an SDK MCP tool (`tools/adapters/sdk-mcp.ts`) and the AI SDK rail into
// an AI SDK tool (`tools/adapters/ai-sdk.ts`), so either rail runs without the
// other's SDK.

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
  /** Keep the tool resident in the prompt instead of deferring it behind tool search. */
  alwaysLoad?: boolean | undefined
  /** Extra words tool search matches the tool by. */
  searchHint?: string | undefined
  /** Protocol metadata passed through unchanged (e.g. MCP `_meta`). */
  _meta?: Record<string, unknown> | undefined
  /**
   * Runs the call and resolves to an MCP `CallToolResult`. A method, so a
   * handler typed for its own parsed arguments still fits the registry.
   */
  handler(args: unknown, extra?: ToolHandlerExtra): unknown
}

/** Optional presentation settings of {@link tool}. */
export interface ToolOptions {
  annotations?: Record<string, unknown> | undefined
  searchHint?: string | undefined
  alwaysLoad?: boolean | undefined
}

/** A definition built by {@link tool}: its handler is typed for its own arguments. */
export interface BuiltinToolDefinition<
  S extends z.ZodRawShape,
  R = unknown,
> extends ToolDefinition {
  description: string
  inputSchema: S
  handler(args: ToolArgs<S>, extra?: ToolHandlerExtra): Promise<R>
}

/**
 * Define a built-in tool: a name, a description the model reads, a zod raw
 * shape for its arguments and the handler that runs a call. Engine-neutral;
 * see the module comment for how each rail registers it.
 */
export function tool<S extends z.ZodRawShape, R>(
  name: string,
  description: string,
  inputSchema: S,
  handler: (args: ToolArgs<S>, extra?: ToolHandlerExtra) => Promise<R>,
  options: ToolOptions = {}
): BuiltinToolDefinition<S, R> {
  return {
    name,
    description,
    inputSchema,
    handler,
    ...(options.annotations ? { annotations: options.annotations } : {}),
    ...(options.alwaysLoad ? { alwaysLoad: true } : {}),
    ...(options.searchHint ? { searchHint: options.searchHint } : {}),
  }
}

/**
 * A definition after middleware replaced its handler: every other field of
 * `D` is kept, and the handler is the generic one.
 */
export type WrappedToolDefinition<D extends ToolDefinition> = Omit<D, "handler"> &
  Pick<ToolDefinition, "handler">

/** A category contributes its definitions at one fixed registry position. */
export interface ToolCategory<Context> {
  readonly id: string
  isEnabled(context: Context): boolean
  create(context: Context): readonly ToolDefinition[]
}

/** Give static and session-bound categories the same collection interface. */
export function defineCategory<Context>({
  id,
  isEnabled,
  tools,
}: {
  id: string
  isEnabled(context: Context): boolean
  tools: readonly ToolDefinition[] | ((context: Context) => readonly ToolDefinition[])
}): ToolCategory<Context> {
  return {
    id,
    isEnabled,
    create: typeof tools === "function" ? tools : () => tools,
  }
}
