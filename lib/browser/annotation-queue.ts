import type { BrowserAnnotationRow } from "@/lib/db/browser-annotations"
import { formatSelectionComment, type OutputDetailLevel } from "./protocol"

export type AnnotationQueueAction =
  | { type: "enqueue"; annotation: BrowserAnnotationRow }
  | { type: "remove"; id: string }
  | { type: "clear" }

export function annotationQueueReducer(
  state: BrowserAnnotationRow[],
  action: AnnotationQueueAction
): BrowserAnnotationRow[] {
  switch (action.type) {
    case "enqueue":
      return state.some((item) => item.id === action.annotation.id)
        ? state
        : [...state, action.annotation]
    case "remove":
      return state.filter((item) => item.id !== action.id)
    case "clear":
      return []
  }
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
  return `# Browser annotation batch (${annotations.length})\n\n${body}`
}
