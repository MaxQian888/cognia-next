import {
  containsSensitiveText,
  type SreEvidence,
  type SreTimelineDraft,
  type SreValidationIssue,
  type SreValidationResult,
} from "./evidence"

function issue(
  code: string,
  message: string,
  extra: Pick<SreValidationIssue, "rowIndex" | "evidenceId"> = {}
): SreValidationIssue {
  return { code, message, ...extra }
}

export function validateTimelineDraft(
  draft: SreTimelineDraft,
  evidence: Iterable<SreEvidence>
): SreValidationResult {
  const evidenceById = new Map<string, SreEvidence>()
  for (const item of evidence) evidenceById.set(item.id, item)
  const issues: SreValidationIssue[] = []

  if (!Array.isArray(draft.rows) || draft.rows.length === 0) {
    issues.push(issue("timeline.empty", "timeline rows must contain at least one row"))
  }

  draft.rows?.forEach((row, rowIndex) => {
    if (!row || typeof row !== "object") {
      issues.push(issue("row.invalid", "timeline row must be an object", { rowIndex }))
      return
    }
    if (!Array.isArray(row.evidenceIds) || row.evidenceIds.length === 0) {
      issues.push(issue("row.evidence_missing", "timeline row must cite evidence", { rowIndex }))
    }
    if (typeof row.confidence !== "number" || row.confidence < 0 || row.confidence > 1) {
      issues.push(
        issue("row.confidence_invalid", "confidence must be between 0 and 1", { rowIndex })
      )
    }
    const citedSources = new Set<string>()
    for (const evidenceId of row.evidenceIds ?? []) {
      const cited = evidenceById.get(evidenceId)
      if (!cited) {
        issues.push(
          issue("row.evidence_unknown", "timeline row cites unknown evidence", {
            rowIndex,
            evidenceId,
          })
        )
      } else {
        citedSources.add(cited.source)
      }
    }
    for (const source of row.sources ?? []) {
      if (source !== "file" && !citedSources.has(source)) {
        issues.push(
          issue("row.source_uncited", `source "${source}" has no cited evidence`, { rowIndex })
        )
      }
    }
    const userFacingText = [row.component, row.event, row.notes, ...(row.signals ?? [])]
      .filter(Boolean)
      .join(" ")
    if (containsSensitiveText(userFacingText)) {
      issues.push(issue("row.sensitive_text", "timeline row contains sensitive text", { rowIndex }))
    }
  })

  for (const section of [draft.findings ?? [], draft.recommendations ?? []]) {
    section.forEach((entry) => {
      for (const evidenceId of entry.evidenceIds ?? []) {
        if (!evidenceById.has(evidenceId)) {
          issues.push(
            issue("finding.evidence_unknown", "finding cites unknown evidence", { evidenceId })
          )
        }
      }
      if (containsSensitiveText(entry.text)) {
        issues.push(issue("finding.sensitive_text", "finding contains sensitive text"))
      }
    })
  }

  return { ok: issues.length === 0, issues, evidenceCount: evidenceById.size }
}
