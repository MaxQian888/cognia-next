// Notification V2 result builder — deterministic journal → summary.
//
// The same RunProjectionSnapshot always yields the same RunResultSummary
// content (modulo the allocated revision/id). Deterministic by construction:
// every fact is derived from a fixed rule over the snapshot's already-safe
// fields — progress counts, terminal status, artifact titles, verification
// totals, the platform-neutral `summary` — never from a model call and never
// from raw event payloads (those are redaction holes by design).
//
// `conclusive` is honest: an inconclusive verification, a truncated journal,
// or a snapshot with no derivable outcome marks the summary inconclusive
// rather than silently reporting success — a fake green is the one result
// this whole projection exists to avoid.

import {
  isTerminalRunStatus,
  type ExecutionTerminalStatus,
  type RunProjectionSnapshot,
} from "@/types/execution/run"
import type { RunResultSummary, RunResultFact } from "@/types/notifications/result"
import type { NotificationDisclosureLevel } from "@/types/notifications/target"
import type { NotificationScope } from "@/types/notifications/scope"
import { scopeKeyOf } from "@/types/notifications/scope"
import { materialHashOfFacts, stableHash } from "./materiality"

/** The schema the builder emits — bump when derivation rules change. */
export const RUN_RESULT_SUMMARY_SCHEMA_VERSION = 1

const DEFAULT_FACT_CAP = 8

/**
 * Derive a result summary's content from a terminal snapshot. Returns the
 * content fields (everything except id/revision/createdAt, which the DB
 * layer allocates). `derivedFromSeq` is the highest journal seq consumed —
 * the projection cursor this summary was built against.
 *
 * `classificationOf` maps each fact kind to its disclosure level — the
 * caller injects the project's policy; the default keeps diagnostics and
 * artifact links `internal` and plain outcome/metric facts `public`.
 */
export function buildRunResultSummaryContent(input: {
  snapshot: RunProjectionSnapshot
  scope: NotificationScope
  derivedFromSeq: number
  /** Per-fact-kind disclosure mapping; defaults below. */
  classificationOf?: (kind: RunResultFact["kind"]) => NotificationDisclosureLevel
  /** Bounded fact cap — prevents a giant run from flooding the summary. */
  factCap?: number
  /** True when the journal was truncated before the terminal event. */
  journalTruncated?: boolean
}): Omit<RunResultSummary, "id" | "revision" | "createdAt"> {
  const { snapshot } = input
  const classificationOf =
    input.classificationOf ??
    ((kind: RunResultFact["kind"]): NotificationDisclosureLevel => {
      switch (kind) {
        case "diagnostic":
        case "artifact":
          return "internal"
        default:
          return "public"
      }
    })
  const factCap = input.factCap ?? DEFAULT_FACT_CAP

  const facts: RunResultFact[] = []
  const push = (fact: RunResultFact) => {
    if (facts.length < factCap) facts.push(fact)
  }

  // Terminal outcome — the headline fact.
  const terminal: ExecutionTerminalStatus = isTerminalRunStatus(snapshot.status)
    ? snapshot.status
    : "failed" // a non-terminal snapshot summarized is a derivation bug → failed
  const outcomeText =
    terminal === "completed"
      ? `Completed in ${formatElapsed(snapshot.elapsedMs)}`
      : terminal === "failed"
        ? `Failed${snapshot.error ? `: ${snapshot.error}` : ""}`
        : "Cancelled"
  push({
    kind: "outcome",
    text: outcomeText,
    classification: classificationOf("outcome"),
  })

  // Verification counts — only totals, never output (redaction invariant).
  for (const artifact of snapshot.artifacts ?? []) {
    if (artifact.kind === "verification" && artifact.verification) {
      const v = artifact.verification
      push({
        kind: "metric",
        text: `${v.passed}/${v.total} checks passed${v.failed > 0 ? `, ${v.failed} failed` : ""}${v.skipped > 0 ? `, ${v.skipped} skipped` : ""}`,
        classification: classificationOf("metric"),
      })
      if (v.conclusion === "inconclusive") {
        push({
          kind: "warning",
          text: "Verification output could not be parsed — result is inconclusive",
          classification: classificationOf("warning"),
        })
      }
    } else {
      push({
        kind: "artifact",
        text: artifact.title,
        classification: classificationOf("artifact"),
        ...(artifact.detailsRef ? { artifactRef: artifact.detailsRef } : {}),
      })
    }
  }

  // Progress metric — only when the total is trustworthy (a missing total
  // must never mint a fake percentage).
  if (snapshot.progress?.trustworthy && snapshot.progress.total > 0) {
    push({
      kind: "metric",
      text: `${snapshot.progress.completed}/${snapshot.progress.total} steps`,
      classification: classificationOf("metric"),
    })
  }

  // Platform-neutral summary — already safe, already redacted.
  if (snapshot.summary) {
    push({
      kind: "decision",
      text: snapshot.summary,
      classification: classificationOf("decision"),
    })
  }

  const maxClassification = facts.reduce<NotificationDisclosureLevel>(
    (max, f) =>
      CLASSIFICATION_RANK[f.classification] > CLASSIFICATION_RANK[max] ? f.classification : max,
    "public"
  )

  // Conclusive only when the derivation is trustworthy: a real terminal
  // status, no truncation, no inconclusive verification, ≥1 outcome fact.
  const hasInconclusiveVerification = (snapshot.artifacts ?? []).some(
    (a) => a.kind === "verification" && a.verification?.conclusion === "inconclusive"
  )
  const conclusive =
    isTerminalRunStatus(snapshot.status) &&
    !input.journalTruncated &&
    !hasInconclusiveVerification &&
    facts.length > 0
  const inconclusiveReason: RunResultSummary["inconclusiveReason"] | undefined = conclusive
    ? undefined
    : input.journalTruncated
      ? "journal-truncated"
      : !isTerminalRunStatus(snapshot.status)
        ? "schema-unknown"
        : "partial-evidence"

  const materialHash = materialHashOfFacts(facts)
  const headline = `${snapshot.title} — ${outcomeText}`
  const digest = `${snapshot.status}:${materialHash.slice(0, 12)}:${facts.length}`

  return {
    scopeKey: scopeKeyOf(input.scope),
    scope: input.scope,
    runId: snapshot.runId,
    terminalStatus: terminal,
    derivedFromSeq: input.derivedFromSeq,
    headline,
    facts,
    digest,
    maxClassification,
    materialHash,
    conclusive,
    ...(inconclusiveReason ? { inconclusiveReason } : {}),
    schemaVersion: RUN_RESULT_SUMMARY_SCHEMA_VERSION,
  }
}

const CLASSIFICATION_RANK: Record<NotificationDisclosureLevel, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
}

function formatElapsed(ms: number | undefined): string {
  if (ms === undefined || ms < 0) return "a moment"
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ${sec % 60}s`
  const hr = Math.floor(min / 60)
  return `${hr}h ${min % 60}m`
}

/**
 * A stable content hash for a notification fact's rendered payload — the
 * value `NotificationRenderedPayload.contentHash` and
 * `intent.payload.contentHash` carry. Computed here so disclosure/materiality
 * stay aligned on one definition.
 */
export function payloadContentHash(parts: {
  title: string
  body: string
  actions?: readonly { kind: string; label: string; ref: string }[]
}): string {
  return stableHash({ t: parts.title, b: parts.body, a: parts.actions ?? [] })
}
