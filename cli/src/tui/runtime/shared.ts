/** Shared helpers for the Cognia runtime controllers. */
import type { DocumentFormat, TuiAction } from "../state/types"

/** Extract a human-readable message from an unknown thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/**
 * Open the scrollable {@link DocumentViewer} pager with a rendered body. Used by
 * the skill / tool detail and `/view` file-viewer controllers so the overlay
 * shape lives in one place.
 */
export function openDocument(
  dispatch: (action: TuiAction) => void,
  doc: { title: string; body: string; format: DocumentFormat; lang?: string }
): void {
  dispatch({
    type: "OVERLAY_OPEN",
    overlay: {
      kind: "document",
      title: doc.title,
      body: doc.body,
      format: doc.format,
      ...(doc.lang ? { lang: doc.lang } : {}),
    },
  })
}

/** Truncate a label to keep the activity pill / select rows compact. */
export function truncate(text: string, max = 60): string {
  const t = text.trim()
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`
}
