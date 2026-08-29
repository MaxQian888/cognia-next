/**
 * Turn an artifact/canvas tool RESULT into the chat part that renders it.
 *
 * This replaces two copies of a near-identical function that both read the
 * model's `tool_use` INPUT instead (`lib/claude/adapter.ts` and
 * `lib/ai/agent/external/event-to-parts.ts`). Reading the input was the bug:
 * a `tool_use` block is seen before the tool has run, so the id in it is
 * whatever the model guessed — and `createArtifact` mints its own. The part
 * therefore pointed at a row that did not exist, and
 * `components/chat/message-parts/artifact-part.tsx` rendered its "cleared"
 * placeholder. The result carries the id the host actually wrote.
 */

import type { ArtifactPart, CanvasInlinePart } from "@/lib/claude/parts-extensions"

const CORE_TOOL_PREFIXES = ["mcp__cognia-plugin-tools__", "mcp__cognia-tools__"]

const ARTIFACT_WRITE_NAMES = new Set(["artifact_create", "artifact_update"])
const CANVAS_WRITE_NAMES = new Set(["canvas_create", "canvas_update", "canvas_open"])

/**
 * Which artifact kinds an `ArtifactPart` badge can carry. Narrower than
 * `ArtifactType` — `jupyter` has no badge, so it falls back to `code`.
 */
const PART_KINDS = new Set<ArtifactPart["kind"]>([
  "code",
  "react",
  "html",
  "svg",
  "mermaid",
  "document",
  "chart",
  "math",
])

/** Strip the provider-specific namespace so both dispatch paths match. */
export function bareToolName(name: string | undefined | null): string {
  if (!name) return ""
  for (const prefix of CORE_TOOL_PREFIXES) {
    if (name.startsWith(prefix)) return name.slice(prefix.length)
  }
  return name
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/**
 * The result may arrive wrapped by the relay (`{result: {...}}`) or bare,
 * depending on which conversion path is calling. Unwrap one level so both work.
 */
function unwrap(result: unknown): Record<string, unknown> | null {
  const outer = record(result)
  if (!outer) return null
  const inner = record(outer.result)
  return inner ?? outer
}

/**
 * Build the part for one completed tool call, or `null` when this is not an
 * artifact tool, the call failed, or the result is malformed.
 *
 * A failed call deliberately produces nothing: the tool card already shows the
 * error, and an artifact card pointing at a row that was never written is the
 * exact failure this module exists to prevent.
 */
export function artifactPartFromToolResult(
  toolName: string,
  result: unknown,
  options: { toolCallId?: string } = {}
): ArtifactPart | CanvasInlinePart | null {
  const bare = bareToolName(toolName)
  const payload = unwrap(result)
  if (!payload || payload.ok !== true) return null

  if (ARTIFACT_WRITE_NAMES.has(bare)) {
    const artifactId = typeof payload.artifactId === "string" ? payload.artifactId : null
    const title = typeof payload.title === "string" ? payload.title : null
    if (!artifactId || !title) return null
    const rawKind = typeof payload.type === "string" ? payload.type : "code"
    const kind = PART_KINDS.has(rawKind as ArtifactPart["kind"])
      ? (rawKind as ArtifactPart["kind"])
      : "code"
    return {
      type: "artifact",
      artifactId,
      title,
      kind,
      ...(options.toolCallId ? { toolCallId: options.toolCallId } : {}),
    }
  }

  if (CANVAS_WRITE_NAMES.has(bare)) {
    const canvasId = typeof payload.documentId === "string" ? payload.documentId : null
    const title = typeof payload.title === "string" ? payload.title : null
    if (!canvasId || !title) return null
    return {
      type: "canvas",
      canvasId,
      title,
      ...(options.toolCallId ? { toolCallId: options.toolCallId } : {}),
    }
  }

  return null
}
