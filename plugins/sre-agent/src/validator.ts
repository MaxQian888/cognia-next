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

type ClaimKind = "service" | "provider" | "status" | "model" | "latency"

const CLAIM_KEYS: Record<ClaimKind, RegExp> = {
  service: /^(service|component)$/i,
  provider: /(^|[._-])(provider|from_provider|to_provider|selected_provider)$/i,
  status: /(^|[._-])(status|status_code)$/i,
  model: /(^|[._-])model(_name)?$/i,
  latency: /(latency|duration)(_ms)?$/i,
}

const CLAIM_PATTERNS: Array<{ kind: Exclude<ClaimKind, "service">; pattern: RegExp }> = [
  { kind: "provider", pattern: /\b[a-z0-9]+-vllm-[a-z0-9-]+\b/gi },
  { kind: "status", pattern: /\bstatus\s*[:=]?\s*([1-5]\d{2}|ok|error)\b/gi },
  { kind: "model", pattern: /\bqwen(?:\d|\/)[a-z0-9./_-]*\b/gi },
  { kind: "latency", pattern: /\b(\d+(?:\.\d+)?)\s*ms\b/gi },
]

const GENERIC_EVENT_WORDS = new Set([
  "request",
  "provider",
  "service",
  "status",
  "model",
  "latency",
  "gateway",
  "qwen",
  "vllm",
])

function collectClaims(value: unknown, path = "", claims?: Record<ClaimKind, Set<string>>) {
  const target =
    claims ??
    ({
      service: new Set<string>(),
      provider: new Set<string>(),
      status: new Set<string>(),
      model: new Set<string>(),
      latency: new Set<string>(),
    } satisfies Record<ClaimKind, Set<string>>)
  if (Array.isArray(value)) {
    value.forEach((entry) => collectClaims(entry, path, target))
    return target
  }
  if (!value || typeof value !== "object") return target
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const nestedPath = path ? `${path}.${key}` : key
    if (typeof nested === "string" || typeof nested === "number") {
      for (const [kind, pattern] of Object.entries(CLAIM_KEYS) as Array<[ClaimKind, RegExp]>) {
        if (pattern.test(nestedPath)) target[kind].add(String(nested).toLowerCase())
      }
    }
    collectClaims(nested, nestedPath, target)
  }
  return target
}

function unsupportedClaims(
  text: string,
  claims: Record<ClaimKind, Set<string>>
): Array<{ kind: ClaimKind; value: string }> {
  const unsupported: Array<{ kind: ClaimKind; value: string }> = []
  for (const { kind, pattern } of CLAIM_PATTERNS) {
    pattern.lastIndex = 0
    for (const match of text.matchAll(pattern)) {
      const value = (match[1] ?? match[0]).toLowerCase()
      if (!claims[kind].has(value)) unsupported.push({ kind, value })
    }
  }
  return unsupported
}

function eventHasEvidenceSupport(event: string, evidence: SreEvidence[]): boolean {
  const evidenceBody = JSON.stringify(evidence).toLowerCase()
  return event
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4 && !GENERIC_EVENT_WORDS.has(word))
    .some((word) => evidenceBody.includes(word))
}

/** Validate a drafted incident timeline against the exact evidence cited by each row. */
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
    const citedEvidence: SreEvidence[] = []
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
        citedEvidence.push(cited)
      }
    }
    for (const source of row.sources ?? []) {
      if (source !== "file" && !citedSources.has(source)) {
        issues.push(
          issue("row.source_uncited", `source "${source}" has no cited evidence`, { rowIndex })
        )
      }
    }
    if (citedEvidence.length > 0) {
      if (citedSources.size === 1 && citedSources.has("metrics")) {
        issues.push(
          issue("row.metrics_only_event", "metrics cannot establish a request event", { rowIndex })
        )
      }
      const claims = collectClaims(citedEvidence)
      if (!claims.service.has(row.component.toLowerCase())) {
        issues.push(
          issue("row.component_unsupported", "component is not present in cited evidence", {
            rowIndex,
          })
        )
      }
      for (const unsupported of unsupportedClaims(
        [row.event, row.notes, ...(row.signals ?? [])].filter(Boolean).join(" "),
        claims
      )) {
        issues.push(
          issue(
            "row.claim_unsupported",
            `${unsupported.kind} value "${unsupported.value}" is not present in cited evidence`,
            { rowIndex }
          )
        )
      }
      if (!eventHasEvidenceSupport(row.event, citedEvidence)) {
        issues.push(
          issue("row.event_unsupported", "event is not supported by cited evidence", { rowIndex })
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
