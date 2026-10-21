/**
 * The plugin contract's share of `lib/automation/model-frame.ts`, which re-exports these.
 */
export type ModelContentBlock =
  { type: "image"; data: string; mimeType: string } | { type: "text"; text: string }

export interface ModelFrameResult {
  content: ModelContentBlock[]
  /**
   * The same object the text block carries. MCP `structuredContent` must be a
   * JSON object, and a caller that reads it instead of the text block must not
   * be the one path that still receives the base64 payload.
   */
  json: Record<string, unknown>
}
