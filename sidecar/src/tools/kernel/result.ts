// MCP `CallToolResult` constructors, so every tool returns the same shape.

import { classifyToolFailure, renderFailureForModel } from "./failure.ts"
import type { ToolFailureKind } from "./failure.ts"

export type ToolContentBlock =
  { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }

/** The failure classification a result carries for the UI and telemetry. */
export type ToolFailureMeta = {
  kind: ToolFailureKind
  retryable: boolean
}

/**
 * A type alias, not an interface: only aliases satisfy the MCP SDK's
 * `CallToolResult` index signature, so a handler can return this directly.
 */
export type ToolResult = {
  content: ToolContentBlock[]
  isError?: true
  _meta?: { "cognia/failure": ToolFailureMeta }
}

/**
 * Build an MCP `CallToolResult` carrying a single text content block.
 * Setting `isError` lets the SDK surface tool failures distinctly from a
 * happy-path text payload.
 *
 * `failure` attaches the structured classification under `_meta` so the UI and
 * telemetry can tell failure kinds apart without parsing the prose the model
 * reads. That is the two-audience split in the shape MCP allows: one text
 * block for the model, typed metadata for everyone else.
 */
export function toolText(
  payload: unknown,
  opts: { isError?: boolean; failure?: ToolFailureMeta } = {}
): ToolResult {
  // Compact (not pretty-printed) JSON: the model parses either form identically,
  // but dropping the 2-space indentation + newlines on every object result trims
  // real tokens across the many object-returning tools (search, hash, stat, …).
  const text = typeof payload === "string" ? payload : JSON.stringify(payload)
  return {
    content: [{ type: "text", text }],
    ...(opts.isError ? { isError: true } : {}),
    ...(opts.failure
      ? {
          _meta: {
            "cognia/failure": { kind: opts.failure.kind, retryable: opts.failure.retryable },
          },
        }
      : {}),
  }
}

/**
 * Convenience constructor for an error result. Accepts either a string
 * message or an Error; in the Error case we strip the stack trace so we
 * don't leak sidecar internals to the agent.
 *
 * The result also says WHAT KIND of failure it was and whether repeating the
 * call could help. Before that, "your disk is full", "you passed the wrong
 * argument" and "the user said no" all reached the model as one boolean plus
 * free text, so it retried all three. See ./failure.ts. A caller-known
 * `opts.kind` wins over inference.
 */
export function toolError(
  err: unknown,
  contextLabel?: string,
  opts: { kind?: ToolFailureKind } = {}
): ToolResult {
  const failure = classifyToolFailure(err, opts)
  return toolText(renderFailureForModel(failure, contextLabel), {
    isError: true,
    failure: { kind: failure.kind, retryable: failure.retryable },
  })
}

/**
 * Build an MCP `CallToolResult` carrying a single image content block
 * (base64 `data`), after an optional leading text block (path / note). The
 * claude-agent-sdk relays this to Claude as a tool_result image; the ai-sdk
 * bridge maps it to a multimodal tool-result part via `toModelOutput`.
 */
export function toolImage(data: string, mimeType: string, caption?: string): ToolResult {
  const content: ToolContentBlock[] = []
  if (caption) content.push({ type: "text", text: caption })
  content.push({ type: "image", data, mimeType })
  return { content }
}
