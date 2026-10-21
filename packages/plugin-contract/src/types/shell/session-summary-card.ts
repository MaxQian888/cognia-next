/**
 * Pure (icon-free) model for the session summary card's row customization.
 *
 * Kept free of React / lucide imports so `AppSettings` can reference it without
 * pulling UI into the settings module graph, like `./workbench-panels`.
 *
 * Each row has one of three visibilities:
 *  - `always` — shown even when empty ("Changes: none" still says something);
 *  - `auto`   — shown only when it has something to say;
 *  - `never`  — not shown; the Task overview panel still has the full data.
 */

export const SUMMARY_CARD_ROW_IDS = [
  "progress",
  "needsYou",
  "changes",
  "artifacts",
  "sources",
  "sharing",
] as const

export type SummaryCardRowId = (typeof SUMMARY_CARD_ROW_IDS)[number]

export type SummaryCardRowVisibility = "always" | "auto" | "never"

export const SUMMARY_CARD_ROW_VISIBILITIES: readonly SummaryCardRowVisibility[] = [
  "always",
  "auto",
  "never",
]

/** User customization of the summary card. Absent rows use the default. */
export interface SessionSummaryCardSettings {
  rows: Partial<Record<SummaryCardRowId, SummaryCardRowVisibility>>
}

/**
 * The shipped visibilities. Progress and needs-you are transient states, so
 * they only appear while they apply; changes and sources are the card's
 * standing content.
 */
export const DEFAULT_SUMMARY_CARD_ROWS: Readonly<
  Record<SummaryCardRowId, SummaryCardRowVisibility>
> = {
  progress: "auto",
  needsYou: "auto",
  changes: "always",
  artifacts: "auto",
  sources: "always",
  sharing: "auto",
}

function isVisibility(value: unknown): value is SummaryCardRowVisibility {
  return value === "always" || value === "auto" || value === "never"
}

/** Stored settings ⊕ defaults; unknown ids and malformed values are dropped. */
export function resolveSummaryCardRows(
  stored: SessionSummaryCardSettings | undefined
): Record<SummaryCardRowId, SummaryCardRowVisibility> {
  const resolved = { ...DEFAULT_SUMMARY_CARD_ROWS }
  for (const id of SUMMARY_CARD_ROW_IDS) {
    const value = stored?.rows?.[id]
    if (isVisibility(value)) resolved[id] = value
  }
  return resolved
}

/** Whether a row renders, given its visibility and whether it has content. */
export function isSummaryCardRowShown(
  visibility: SummaryCardRowVisibility,
  hasContent: boolean
): boolean {
  return visibility === "always" || (visibility === "auto" && hasContent)
}
