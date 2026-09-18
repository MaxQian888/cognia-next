/**
 * Defensive reader for a persisted {@link ContextSelectionRef}.
 *
 * Draft rows carry staged selections across restarts, and a row can outlive
 * the build that wrote it — a newer build may have added a kind or required a
 * field this one does not know. Restoring such an entry whole would stage a
 * chip whose snapshot the renderer and the prompt formatter both trust, so a
 * malformed entry reads as "absent" here rather than reaching the chip bar.
 *
 * The check is per-variant on the required discriminant fields only; extra
 * keys pass through untouched so a newer build's fields survive the
 * round-trip on a build that does not understand them.
 */

import type { ContextSelectionRef, EntitySelectionKind } from "@/types/artifact/artifact"

const ENTITY_KINDS: ReadonlySet<string> = new Set([
  "memory",
  "issue",
  "plan",
  "session",
  "message",
  "prompt",
  "result",
  "artifact",
  "teammate",
] satisfies EntitySelectionKind[])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isBase(value: Record<string, unknown>): boolean {
  return (
    typeof value.title === "string" &&
    typeof value.snapshot === "string" &&
    typeof value.comment === "string"
  )
}

/** A persisted value that can be trusted as a {@link ContextSelectionRef}. */
export function isContextSelectionRef(value: unknown): value is ContextSelectionRef {
  if (!isRecord(value) || !isBase(value)) return false
  switch (value.kind) {
    case "artifact":
      return (
        typeof value.artifactId === "string" &&
        isRecord(value.range) &&
        typeof value.range.startLine === "number" &&
        typeof value.range.endLine === "number"
      )
    case "file":
      return typeof value.relPath === "string"
    case "comment":
      return true
    case "web":
      return typeof value.url === "string"
    case "external":
      return (
        typeof value.candidateId === "string" &&
        typeof value.sourceApp === "string" &&
        (value.origin === "accessibility" ||
          value.origin === "clipboard" ||
          value.origin === "ocr") &&
        typeof value.truncated === "boolean"
      )
    case "plugin":
      return typeof value.pluginId === "string" && typeof value.sourceLabel === "string"
    case "entity":
      return (
        typeof value.entityKind === "string" &&
        ENTITY_KINDS.has(value.entityKind) &&
        typeof value.entityId === "string" &&
        typeof value.capturedAt === "number"
      )
    default:
      return false
  }
}
