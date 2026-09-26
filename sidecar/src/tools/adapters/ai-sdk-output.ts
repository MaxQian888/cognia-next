// How an MCP `CallToolResult` reaches the model on the AI SDK rail: flattened
// to text when it is text only, mapped to AI SDK content parts when it carries
// images, audio or embedded resources.

import type { Tool } from "ai"

/** What an AI SDK tool's `toModelOutput` returns. */
export type AiSdkModelOutput = Awaited<ReturnType<NonNullable<Tool["toModelOutput"]>>>

type ContentPart = Extract<AiSdkModelOutput, { type: "content" }>["value"][number]

/** The MCP content-block fields the mapping reads. */
interface McpBlock {
  type?: unknown
  text?: unknown
  data?: unknown
  mimeType?: unknown
  uri?: unknown
  name?: unknown
  title?: unknown
  resource?: {
    text?: unknown
    blob?: unknown
    mimeType?: unknown
    name?: unknown
    title?: unknown
  }
}

/** The content blocks of a result, or none. */
function blocksOf(result: unknown): McpBlock[] {
  const content = (result as { content?: unknown } | null | undefined)?.content
  return Array.isArray(content) ? (content as McpBlock[]) : []
}

/** Flatten an MCP `CallToolResult` to a plain string for the model. */
export function callToolResultToText(result: unknown): string {
  if (result == null) return ""
  if (typeof result === "string") return result
  const content = (result as { content?: unknown }).content
  if (Array.isArray(content)) {
    return (content as (McpBlock | null)[])
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b!.text as string)
      .join("\n")
  }
  return JSON.stringify(result)
}

/**
 * Does an MCP CallToolResult carry content that must remain structured for the
 * model-output mapper? Text-only results keep their legacy flattened behavior.
 */
export function hasRichContentBlock(result: unknown): boolean {
  return blocksOf(result).some(
    (b) =>
      b &&
      (b.type === "image" ||
        b.type === "audio" ||
        b.type === "resource" ||
        b.type === "resource_link")
  )
}

/**
 * AI SDK 7 collapsed the `image-*` / `file-*` tool-result content variants into
 * one canonical `file` part carrying a TAGGED data union — images are just files
 * with an image media type, so the image/non-image split is gone. `{ type:
 * 'data', data }` is the inline-bytes/base64 arm; `url`, `reference` and `text`
 * are the others. v7 still auto-migrates the legacy shapes at runtime, but only
 * until the next major.
 */
function binaryModelPart(data: unknown, mediaType: unknown, filename?: unknown): ContentPart {
  return {
    type: "file",
    mediaType,
    data: { type: "data", data },
    ...(filename ? { filename } : {}),
  } as ContentPart
}

/**
 * Map a tool's execute output to an AI SDK model output. Text results stay
 * plain text (unchanged behavior); image, audio, and embedded-resource results
 * become content parts so models receive the actual payload.
 */
export function builtinToModelOutput({ output }: { output: unknown }): AiSdkModelOutput {
  if (typeof output === "string") return { type: "text", value: output }
  const value: ContentPart[] = []
  for (const b of blocksOf(output)) {
    if (b.type === "text" && typeof b.text === "string") {
      value.push({ type: "text", text: b.text })
    } else if (b.type === "image" && b.data) {
      const mediaType = b.mimeType ?? "image/png"
      value.push(binaryModelPart(b.data, mediaType))
    } else if (b.type === "audio" && b.data) {
      value.push(binaryModelPart(b.data, b.mimeType ?? "audio/mpeg"))
    } else if (b.type === "resource" && b.resource) {
      const resource = b.resource
      if (typeof resource.text === "string") {
        value.push({ type: "text", text: resource.text })
      } else if (typeof resource.blob === "string") {
        value.push(
          binaryModelPart(
            resource.blob,
            resource.mimeType ?? "application/octet-stream",
            resource.name ?? resource.title
          )
        )
      }
    } else if (b.type === "resource_link" && typeof b.uri === "string") {
      const label =
        typeof b.name === "string" && b.name.length > 0
          ? `${b.name}: `
          : typeof b.title === "string" && b.title.length > 0
            ? `${b.title}: `
            : ""
      value.push({ type: "text", text: `${label}${b.uri}` })
    }
  }
  return { type: "content", value }
}
