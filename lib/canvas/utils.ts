/**
 * Canvas Utilities - Shared utility functions for Canvas components
 */

import type { CollaborationConnectionState } from "@/types/canvas/panel"
import type { CanvasPerformanceMode } from "@/types"

/**
 * Format a date relative to now (e.g., "just now", "5 minutes ago", "3 days ago")
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function formatRelativeDate(date: Date, t: (key: string, params?: any) => string): string {
  const now = new Date()
  const d = new Date(date)
  const diffMs = now.getTime() - d.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMins < 1) return t("justNow")
  if (diffMins < 60) return t("minutesAgo", { count: diffMins })
  if (diffHours < 24) return t("hoursAgo", { count: diffHours })
  if (diffDays < 7) return t("daysAgo", { count: diffDays })
  return d.toLocaleDateString()
}

/**
 * Get date key for grouping (uses local date)
 */
export function getDateKey(date: Date): string {
  return new Date(date).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  })
}

/**
 * Format file size in human-readable format
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B"
  const k = 1024
  const sizes = ["B", "KB", "MB", "GB"]
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
}

/**
 * Get file extension mapping for export
 */
export const FILE_EXTENSION_MAP: Record<string, string> = {
  javascript: "js",
  typescript: "ts",
  python: "py",
  html: "html",
  css: "css",
  json: "json",
  markdown: "md",
  jsx: "jsx",
  tsx: "tsx",
  sql: "sql",
  bash: "sh",
  yaml: "yaml",
  xml: "xml",
}

/**
 * Get Monaco language mapping
 */
export const MONACO_LANGUAGE_MAP: Record<string, string> = {
  javascript: "javascript",
  typescript: "typescript",
  python: "python",
  html: "html",
  css: "css",
  json: "json",
  markdown: "markdown",
  jsx: "javascript",
  tsx: "typescript",
  sql: "sql",
  bash: "shell",
  yaml: "yaml",
  xml: "xml",
}

/**
 * Get Monaco language for a given language string
 */
export function getMonacoLanguage(language: string): string {
  return MONACO_LANGUAGE_MAP[language] || "plaintext"
}

/**
 * Get file extension for a given language
 */
export function getFileExtension(language: string): string {
  return FILE_EXTENSION_MAP[language] || "txt"
}

/**
 * Generate a safe filename from title
 */
export function generateSafeFilename(title: string, language: string): string {
  const safeName = title.replace(/[^a-zA-Z0-9]/g, "_")
  const ext = getFileExtension(language)
  return `${safeName}.${ext}`
}

/**
 * Calculate document statistics
 */
export function calculateDocumentStats(content: string): {
  lines: number
  words: number
  chars: number
} {
  if (!content) return { lines: 0, words: 0, chars: 0 }
  const lines = content.split("\n").length
  const words = content.trim() ? content.trim().split(/\s+/).length : 0
  const chars = content.length
  return { lines, words, chars }
}

/**
 * Count lines in content without allocating a temporary array
 */
export function countLines(content: string): number {
  if (!content) return 0
  return (content.match(/\n/g) || []).length + 1
}

export const CANVAS_LARGE_DOCUMENT_THRESHOLDS = {
  largeChars: 50000,
  veryLargeChars: 200000,
  largeLines: 1500,
  veryLargeLines: 5000,
} as const

export interface CanvasPerformanceProfile {
  mode: CanvasPerformanceMode
  lineCount: number
  charCount: number
  enableChunking: boolean
  outlineRefresh: "eager" | "deferred" | "manual"
  symbolParseDebounceMs: number
  showStickyScroll: boolean
  showDegradedModeNotice: boolean
}

export function getCanvasPerformanceProfile(content: string): CanvasPerformanceProfile {
  const charCount = content.length
  const lineCount = countLines(content)

  if (
    charCount > CANVAS_LARGE_DOCUMENT_THRESHOLDS.veryLargeChars ||
    lineCount > CANVAS_LARGE_DOCUMENT_THRESHOLDS.veryLargeLines
  ) {
    return {
      mode: "very-large",
      lineCount,
      charCount,
      enableChunking: true,
      outlineRefresh: "manual",
      symbolParseDebounceMs: 1500,
      showStickyScroll: false,
      showDegradedModeNotice: true,
    }
  }

  if (
    charCount > CANVAS_LARGE_DOCUMENT_THRESHOLDS.largeChars ||
    lineCount > CANVAS_LARGE_DOCUMENT_THRESHOLDS.largeLines
  ) {
    return {
      mode: "large",
      lineCount,
      charCount,
      enableChunking: true,
      outlineRefresh: "deferred",
      symbolParseDebounceMs: 900,
      showStickyScroll: true,
      showDegradedModeNotice: true,
    }
  }

  return {
    mode: "standard",
    lineCount,
    charCount,
    enableChunking: false,
    outlineRefresh: "eager",
    symbolParseDebounceMs: 500,
    showStickyScroll: true,
    showDegradedModeNotice: false,
  }
}

/**
 * Check if a document is considered large (for optimization purposes)
 */
export function isLargeDocument(
  content: string,
  threshold: number = CANVAS_LARGE_DOCUMENT_THRESHOLDS.largeChars
): boolean {
  return content.length > threshold
}

/**
 * Truncate text with ellipsis
 */
export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return text.slice(0, maxLength - 3) + "..."
}

/**
 * Check if a language is compatible with the V0 Designer
 */
export function isDesignerCompatible(language: string): boolean {
  return ["jsx", "tsx", "html", "javascript", "typescript"].includes(language)
}

/**
 * Export a canvas document as a file download
 */
export function exportCanvasDocument(title: string, content: string, language: string): void {
  const ext = getFileExtension(language)
  const filename = `${title.replace(/[^a-zA-Z0-9]/g, "_")}.${ext}`
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/**
 * Get CSS color class for collaboration connection state
 */
export function getConnectionStatusColor(state: CollaborationConnectionState): string {
  switch (state) {
    case "connected":
      return "text-green-500"
    case "connecting":
      return "text-yellow-500"
    case "error":
      return "text-red-500"
    default:
      return "text-muted-foreground"
  }
}
