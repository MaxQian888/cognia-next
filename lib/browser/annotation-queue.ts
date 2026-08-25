import type { BrowserAnnotationRow } from "@/lib/db/browser-annotations"
import { formatSelectionComment, type OutputDetailLevel } from "./protocol"

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
  return `# Browser annotation batch (${annotations.length})\n\n${body}`
}
