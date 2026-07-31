/**
 * Pure extractor for image content blocks buried in a tool result. Tools that
 * return screenshots / rendered images (computer-use, screenshot, many MCP
 * servers) deliver base64 image blocks that the text renderer would otherwise
 * dump as a giant base64 string. This walks the result and pulls out every
 * image block so {@link ../components/CellView} can render it inline (on a
 * graphics-capable terminal) or as a compact placeholder.
 *
 * Supports the two common shapes:
 *  - Anthropic content block: `{ type:"image", source:{ type:"base64", media_type, data } }`
 *  - MCP image content:       `{ type:"image", data, mimeType }`
 * Nested arrays / `.content` wrappers are walked recursively.
 */

/** One image pulled out of a tool result. */
export interface ExtractedImage {
  /** Base64 payload (no data-URI prefix). */
  data: string
  /** MIME type, e.g. "image/png". Defaults to "image/png" when unstated. */
  mediaType: string
  /** Decoded byte length, for the "(12.3 KB)" placeholder. */
  bytes: number
}

/** Decoded byte length of a base64 string (no allocation). */
export function base64ByteLength(b64: string): number {
  const len = b64.length
  if (len === 0) return 0
  let padding = 0
  if (b64.endsWith("==")) padding = 2
  else if (b64.endsWith("=")) padding = 1
  return Math.floor((len * 3) / 4) - padding
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null
}

/** Pull an image block out of one node, or null when it isn't one. */
function imageOf(node: Record<string, unknown>): ExtractedImage | null {
  if (node.type !== "image") return null
  // Anthropic shape: nested under `source`.
  const source = node.source
  if (isRecord(source) && typeof source.data === "string") {
    const mediaType = typeof source.media_type === "string" ? source.media_type : "image/png"
    return { data: source.data, mediaType, bytes: base64ByteLength(source.data) }
  }
  // MCP shape: flat `data` + `mimeType`.
  if (typeof node.data === "string") {
    const mediaType = typeof node.mimeType === "string" ? node.mimeType : "image/png"
    return { data: node.data, mediaType, bytes: base64ByteLength(node.data) }
  }
  return null
}

/** Recursively collect every image block in a tool result (depth-bounded). */
export function extractResultImages(result: unknown, depth = 0): ExtractedImage[] {
  if (depth > 6 || result == null) return []
  if (Array.isArray(result)) {
    return result.flatMap((item) => extractResultImages(item, depth + 1))
  }
  if (!isRecord(result)) return []
  const direct = imageOf(result)
  if (direct) return [direct]
  // Walk a `content` wrapper (Anthropic/MCP tool results often nest there).
  if ("content" in result) return extractResultImages(result.content, depth + 1)
  return []
}

/**
 * Return a copy of `result` with every image block's base64 payload replaced by
 * a short marker, so the text renderer shows structure (and any captions)
 * without dumping a multi-KB base64 string. The images themselves render
 * separately via {@link extractResultImages}.
 */
export function elideImageData(result: unknown, depth = 0): unknown {
  if (depth > 6 || result == null) return result
  if (Array.isArray(result)) return result.map((item) => elideImageData(item, depth + 1))
  if (!isRecord(result)) return result
  if (imageOf(result)) {
    const out: Record<string, unknown> = { ...result }
    if (typeof out.data === "string") out.data = "<image>"
    if (isRecord(out.source) && typeof out.source.data === "string") {
      out.source = { ...out.source, data: "<image>" }
    }
    return out
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(result)) out[k] = elideImageData(v, depth + 1)
  return out
}

/** Humanize a byte count: "938 B", "12.3 KB", "1.2 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
