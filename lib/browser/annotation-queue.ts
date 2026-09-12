import { resolveAnnotationTarget, type BrowserAnnotationRow } from "@/lib/db/browser-annotations"
import { formatSelectionComment, type OutputDetailLevel } from "./protocol"

/**
 * What the batch heading calls itself.
 *
 * Derived from the rows rather than hard-coded: the queue is shared with the
 * artifact preview, and announcing a set of artifact elements as a "Browser
 * annotation batch" would send the model looking for a web page that was never
 * involved. A batch is scoped to one surface by construction (readers take a
 * scope filter), so the first row decides; a mixed batch falls back to the
 * neutral noun rather than picking a side.
 */
export function annotationBatchHeading(annotations: BrowserAnnotationRow[]): string {
  const kinds = new Set(annotations.map((row) => resolveAnnotationTarget(row).kind))
  if (kinds.size !== 1) return "Review annotation batch"
  return kinds.has("artifact") ? "Artifact annotation batch" : "Browser annotation batch"
}

export function formatAnnotationBatch(
  annotations: BrowserAnnotationRow[],
  detailLevel: OutputDetailLevel = "standard"
): string {
  const body = annotations
    .map(
      (annotation, index) =>
        `## Annotation ${index + 1} — ${annotation.intent} / ${annotation.severity}\n\n${formatSelectionComment(annotation.selection, annotation.comment, detailLevel)}`
    )
    .join("\n\n---\n\n")
  return `# ${annotationBatchHeading(annotations)} (${annotations.length})\n\n${body}`
}
