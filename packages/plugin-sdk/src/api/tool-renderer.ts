/** Portable contracts and protocol helpers for plugin tool-result renderers. */

import type React from "react"
import type { DynamicToolUIPart, ToolUIPart } from "ai"

export { defineToolRenderer } from "../define/define-tool-renderer"

export interface ToolResultRendererProps {
  /** The tool part exactly as it sits in `UIMessage.parts`. */
  part: ToolUIPart | DynamicToolUIPart
  /** Chat session this tool call belongs to, when the host knows it. */
  sessionId?: string
}

export interface ToolResultRendererEntry {
  pluginId: string
  toolName: string
  component: React.ComponentType<ToolResultRendererProps>
}

/** One content block returned by an MCP-compatible tool. */
export type McpResultBlock =
  | { type: "text"; text: string }
  | {
      type: "image"
      data?: string
      mimeType?: string
      source?: { type?: string; media_type?: string; data?: string }
    }
  | { type: "audio"; data?: string; mimeType?: string }
  | {
      type: "resource"
      resource?: { uri?: string; mimeType?: string; text?: string; blob?: string }
      [key: string]: unknown
    }
  | { type: string; [key: string]: unknown }

/** Parse the two output shapes accepted by the renderer boundary. */
export function parseOutputJson(output: unknown): unknown | null {
  if (output === null || output === undefined) return null
  if (typeof output === "string") {
    const trimmed = output.trim()
    if (!trimmed) return null
    try {
      return JSON.parse(trimmed)
    } catch {
      return null
    }
  }
  return typeof output === "object" ? output : null
}

/** Extract the hostname used by compact URL badges. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  rb: "ruby",
  cs: "csharp",
  c: "c",
  cpp: "cpp",
  h: "c",
  hpp: "cpp",
  md: "markdown",
  json: "json",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  css: "css",
  html: "html",
  sh: "bash",
  sql: "sql",
}

/** Map a file extension to the host's syntax-highlighting language id. */
export function languageFromPath(path: string | undefined): string {
  if (!path) return "text"
  const ext = path.toLowerCase().split(".").pop() ?? ""
  return LANGUAGE_BY_EXT[ext] ?? "text"
}

/** Build a loadable media URL from either supported MCP image/audio shape. */
export function blockMediaSrc(block: McpResultBlock, fallbackMime: string): string | null {
  const candidate = block as {
    data?: unknown
    mimeType?: unknown
    source?: { data?: unknown; media_type?: unknown }
  }
  if (typeof candidate.data === "string" && candidate.data.length > 0) {
    const mime = typeof candidate.mimeType === "string" ? candidate.mimeType : fallbackMime
    return candidate.data.startsWith("data:")
      ? candidate.data
      : `data:${mime};base64,${candidate.data}`
  }
  const source = candidate.source
  if (source && typeof source.data === "string" && source.data.length > 0) {
    const mime = typeof source.media_type === "string" ? source.media_type : fallbackMime
    return source.data.startsWith("data:") ? source.data : `data:${mime};base64,${source.data}`
  }
  return null
}
