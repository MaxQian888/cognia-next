/**
 * Projection of a capture-bearing automation payload into MCP content blocks.
 *
 * Every model-facing Computer Use surface returns a payload with an inline
 * base64 `screenshot`. Serialising that whole payload with `JSON.stringify`
 * hands the model a screenshot as *text*, which it cannot look at, and which
 * costs six figures of tokens for a single frame. The frame has to leave as an
 * MCP `image` block instead, with the JSON half keeping the dimensions but not
 * the bytes.
 *
 * Two surfaces need the identical projection, so it lives here rather than in
 * either of them:
 *
 * 1. `plugins/computer-use` (the in-app tools, via `@cognia/plugin-sdk`)
 * 2. `lib/external-bridge/mcp-server/server.ts` (the `computer_use` tool an
 *    external MCP client drives)
 */

import type { ImageFormat, Screenshot } from "./types"

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

/** MCP image blocks are typed by media type, not by the backend's enum. */
export function screenshotMimeType(format: ImageFormat): string {
  return format === "jpeg" ? "image/jpeg" : "image/png"
}

/**
 * Drop the bytes but keep everything that describes the frame.
 *
 * The dimensions are load-bearing rather than informational: a pixel-target
 * action carries `screenshotWidth` / `screenshotHeight` and is rejected when
 * they do not match the surface it was measured against.
 */
export function screenshotMetadata(screenshot: Screenshot): Omit<Screenshot, "bytes"> {
  const { bytes: _bytes, ...rest } = screenshot
  return rest
}

/**
 * Split a payload carrying an inline frame into an image block plus a JSON
 * block stripped of the bytes.
 *
 * A payload whose frame was withheld (screenshot dedup clears `bytes` and
 * leaves the dimensions in place) yields the JSON block alone, which is the
 * entire point of the dedup: nothing new to look at, so nothing is sent.
 */
export function frameToModelContent<T extends { screenshot?: Screenshot | null }>(
  payload: T
): ModelFrameResult {
  const { screenshot, ...rest } = payload
  const content: ModelContentBlock[] = []

  if (screenshot?.bytes) {
    content.push({
      type: "image",
      data: screenshot.bytes,
      mimeType: screenshotMimeType(screenshot.format),
    })
  }

  const json: Record<string, unknown> = {
    ...rest,
    screenshot: screenshot ? screenshotMetadata(screenshot) : null,
  }
  content.push({ type: "text", text: JSON.stringify(json) })
  return { content, json }
}

/**
 * True when a value looks like a payload this module should project.
 *
 * The External Bridge multiplexes several operations through one tool, and
 * only the capture-bearing ones carry a frame. Everything else keeps the plain
 * JSON envelope it has always had.
 */
export function carriesFrame(value: unknown): value is { screenshot: Screenshot | null } {
  if (value === null || typeof value !== "object") return false
  if (!("screenshot" in value)) return false
  const screenshot = (value as { screenshot: unknown }).screenshot
  if (screenshot === null) return true
  return (
    typeof screenshot === "object" &&
    screenshot !== null &&
    "bytes" in screenshot &&
    "width" in screenshot &&
    "height" in screenshot
  )
}
