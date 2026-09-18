// Notification V2 result-summary contract.
//
// `RunResultSummary` is the IMMUTABLE, content-addressed evidence a terminal
// result notification renders from. The builder derives it deterministically
// from the Run Journal — the same journal always produces the same summary —
// and the projection work row's `desiredResultRevision` / `processedResult-
// Revision` cursors track which revisions have been consumed.
//
// The summary is deliberately a *projection* of the journal, not a new fact:
// late refinement (a summary that materializes after the terminal event)
// bumps the revision without re-opening the run or minting a second terminal
// journal event.

import type { NotificationScope } from "./scope"
import type { ExecutionTerminalStatus } from "@/types/execution/run"
import type { NotificationLevel } from "./index"
import type { NotificationDisclosureLevel } from "./target"

/**
 * Immutable result evidence for one run, one revision.
 *
 * `revision` is the content-addressed version — two summaries with the same
 * `runId` and `revision` are the same evidence; a re-derived summary with
 * different content mints the next revision rather than mutating in place.
 */
export interface RunResultSummary {
  id: string
  scopeKey: string
  scope: NotificationScope
  runId: string
  /** Monotonic per-run revision — bumps on every re-derivation. */
  revision: number
  /** The terminal status the journal concluded — never re-opened. */
  terminalStatus: ExecutionTerminalStatus
  /** Highest journal seq this summary was derived from — the cursor input. */
  derivedFromSeq: number
  /** The headline the result notification leads with. */
  headline: string
  /** The evidence the summary cites — bounded, classified per entry. */
  facts: RunResultFact[]
  /** The LLM-free digest — deterministic template output only. */
  digest: string
  /**
   * The disclosure classification of the RICHEST fact inside — the target's
   * ceiling clips from here down, never up.
   */
  maxClassification: NotificationDisclosureLevel
  /**
   * Semantic hash of the material content — the "did anything actually
   * change" signal for suppress-if-unchanged and accepted-vs-duplicate.
   */
  materialHash: string
  /** Whether derivation was conclusive — an unparsable journal is NOT success. */
  conclusive: boolean
  /** Why derivation was inconclusive, when it was. */
  inconclusiveReason?: "journal-truncated" | "schema-unknown" | "partial-evidence"
  /** The schema this summary was derived under — replay detection. */
  schemaVersion: number
  createdAt: number
}

/** One classified evidence line inside a summary. */
export interface RunResultFact {
  /** Stable kind — renderers switch on it. */
  kind:
    | "metric" // "12 tests passed"
    | "artifact" // "report.html"
    | "decision" // "approved by X"
    | "warning" // "2 flaky retries"
    | "outcome" // "PR #123 merged"
    | "diagnostic" // error excerpt — classified, may be redacted
  /** The rendered line — already template-safe (no secrets by construction). */
  text: string
  /** This fact's classification — the target ceiling filters, never widens. */
  classification: NotificationDisclosureLevel
  /** Optional artifact handle — only sent when the profile allows links. */
  artifactRef?: string
  /** Whether this fact survived redaction — evidence for "clipped N facts". */
  redacted?: boolean
}

/** The planner's materiality verdict for one notification fact. */
export interface NotificationMaterialityVerdict {
  /** Whether the fact is materially new vs. its baseline. */
  material: boolean
  /** The hash that was compared — baselines index on it. */
  materialHash: string
  /** The baseline this was compared against. */
  baselineKind: "none" | "same-operation" | "same-slot" | "same-incident"
  /** Why it was judged immaterial, when it was. */
  reason?: "unchanged" | "subset" | "echo"
}

/** The renderable payload one intent freezes — the post-disclosure view. */
export interface NotificationRenderedPayload {
  title: string
  body: string
  level: NotificationLevel
  actions?: { kind: string; label: string; ref: string }[]
  disclosureLevel: NotificationDisclosureLevel
  /** How many facts the target's ceiling clipped — shown as "+N more". */
  clippedFactCount: number
  contentHash: string
}
