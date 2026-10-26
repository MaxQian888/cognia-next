/**
 * The plugin contract's share of `lib/plugin/api/tool-result-renderers.ts`, which re-exports these.
 */
import type { DynamicToolUIPart, ToolUIPart } from "ai"

export interface ToolResultRendererProps {
  /** The tool part, exactly as it sits in `UIMessage.parts[i]`. */
  part: ToolUIPart | DynamicToolUIPart
  /** Chat session this tool call belongs to, when the host knows it. */
  sessionId?: string
}
