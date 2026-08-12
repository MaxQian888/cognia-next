"use client"

/**
 * Smart snapshots reuse the existing desktop automation state capture:
 * app-scoped screenshot + accessibility tree → ordinary composer attachments.
 *
 * The screenshot is staged as an image attachment. The accessibility projection
 * is staged as a Markdown attachment, so the existing attachment extraction and
 * PII gates own the outbound model payload. No parallel attachment transport.
 */

import { desktop } from "@/lib/automation/client"
import type { ElementInfo, UiStateRevision, UiTreeNode } from "@/lib/automation/types"
import { detectSourceApp } from "@/lib/capture/capture-manager"

export const SMART_SNAPSHOT_COMMAND_ID = "chat.captureSmartSnapshot"

const MAX_UI_TEXT_CHARS = 20_000
const TREE_MAX_DEPTH = 12
const TREE_MAX_NODES = 600

export interface SmartSnapshotResult {
  appName: string
  windowTitle?: string
  files: File[]
  truncated: boolean
}

export class SmartSnapshotError extends Error {
  constructor(
    public readonly code: "no-focused-app" | "empty" | "capture-failed",
    message: string
  ) {
    super(message)
    this.name = "SmartSnapshotError"
  }
}

interface BuildOptions {
  capturedAt?: number
}

function randomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function filenamePart(value: string): string {
  return (
    value
      .trim()
      .replace(/[\\/:*?"<>|]+/g, "-")
      .replace(/\s+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "app"
  )
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
  return out
}

function makeFileName(prefix: string, appName: string, ext: string, capturedAt: number): string {
  const stamp = new Date(capturedAt)
    .toISOString()
    .replaceAll(/[:.]/g, "-")
    .replace("T", "_")
    .replace("Z", "")
  return `${prefix}-${filenamePart(appName)}-${stamp}.${ext}`
}

function labelFor(element: ElementInfo): string | null {
  const parts: string[] = []
  const role = element.controlType?.trim()
  const name = element.name?.trim()
  if (role) parts.push(`[${role}]`)
  if (name) parts.push(name)
  return parts.length > 0 ? parts.join(" ") : null
}

function nodeDepth(nodes: readonly UiTreeNode[], index: number): number {
  let depth = 0
  let parent = nodes[index]?.parentIndex ?? null
  const seen = new Set<number>()
  while (typeof parent === "number" && parent >= 0 && parent < nodes.length && !seen.has(parent)) {
    seen.add(parent)
    depth += 1
    parent = nodes[parent]?.parentIndex ?? null
  }
  return depth
}

export function accessibilityMarkdown(state: UiStateRevision): {
  markdown: string
  truncated: boolean
} {
  const lines: string[] = []
  const seen = new Set<string>()

  for (let index = 0; index < state.tree.nodes.length; index += 1) {
    const node = state.tree.nodes[index]
    const label = labelFor(node.element)
    if (!label) continue
    const depth = Math.min(nodeDepth(state.tree.nodes, index), 8)
    const line = `${"  ".repeat(depth)}- ${label}`
    const dedupeKey = line.trim()
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    lines.push(line)
  }

  let body = lines.join("\n").trim()
  let truncated = state.tree.truncated || state.truncation.length > 0 || false
  if (body.length > MAX_UI_TEXT_CHARS) {
    body = body.slice(0, MAX_UI_TEXT_CHARS).trimEnd()
    truncated = true
  }
  if (!body) body = "No accessibility text was exposed for this window."
  return { markdown: body, truncated }
}

export function buildSmartSnapshotFiles(
  state: UiStateRevision,
  options: BuildOptions = {}
): SmartSnapshotResult {
  const capturedAt = options.capturedAt ?? state.capturedAt ?? Date.now()
  const appName = state.app.displayName || "Application"
  const windowTitle =
    state.tree.nodes[0]?.element.windowTitle ?? state.tree.nodes[0]?.element.name ?? undefined
  const { markdown: uiText, truncated } = accessibilityMarkdown(state)

  const context = [
    "# Smart snapshot",
    "",
    `- App: ${appName}`,
    ...(windowTitle ? [`- Window: ${windowTitle}`] : []),
    `- Captured at: ${new Date(capturedAt).toISOString()}`,
    "- Text source: desktop accessibility tree captured by Cognia automation",
    ...(truncated ? ["- Note: accessibility text was truncated before attaching"] : []),
    "",
    "## Accessibility text",
    "",
    uiText,
    "",
  ].join("\n")

  const files: File[] = [
    new File([context], makeFileName("smart-snapshot-context", appName, "md", capturedAt), {
      lastModified: capturedAt,
      type: "text/markdown",
    }),
  ]

  if (state.screenshot?.bytes) {
    const mediaType = state.screenshot.format === "jpeg" ? "image/jpeg" : "image/png"
    const ext = state.screenshot.format === "jpeg" ? "jpg" : "png"
    files.unshift(
      new File(
        [new Uint8Array(base64ToBytes(state.screenshot.bytes)).buffer],
        makeFileName("smart-snapshot", appName, ext, capturedAt),
        {
          lastModified: capturedAt,
          type: mediaType,
        }
      )
    )
  }

  if (files.length === 0) {
    throw new SmartSnapshotError("empty", "Smart snapshot did not produce any attachments")
  }

  return { appName, ...(windowTitle ? { windowTitle } : {}), files, truncated }
}

export async function captureSmartSnapshotFiles(): Promise<SmartSnapshotResult> {
  try {
    const focus = await desktop.getFocus({ surface: "workflow" })
    const displayName = focus.processName?.trim() || (await detectSourceApp())?.trim()
    if (!displayName) {
      throw new SmartSnapshotError("no-focused-app", "No focused desktop application was detected")
    }

    const state = await desktop.getAppState(
      `smart-snapshot-${randomId()}`,
      { kind: "displayName", displayName },
      {
        disableDiff: true,
        maxDepth: TREE_MAX_DEPTH,
        maxNodes: TREE_MAX_NODES,
        projection: "model",
      },
      { surface: "workflow" }
    )
    return buildSmartSnapshotFiles(state)
  } catch (error) {
    if (error instanceof SmartSnapshotError) throw error
    throw new SmartSnapshotError(
      "capture-failed",
      error instanceof Error ? error.message : "Smart snapshot capture failed"
    )
  }
}
