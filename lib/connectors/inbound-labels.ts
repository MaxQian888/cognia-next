/**
 * Validate, cap and stamp the labels plugins attach to inbound IM messages
 * (`onConnectorInbound` → `{ action: "annotate", labels }`).
 *
 * Plugin output is untrusted — a Python hook's return value reaches the
 * dispatcher raw — so nothing is persisted unless it has a well-formed key and
 * a finite score in 0..1. Notes are redacted (PII → `<KIND_NNN>` placeholders)
 * and dropped if anything survives the gate (the label stays). Caps: 8 labels
 * per plugin, 16 per message.
 */

import { hasNoLeakingPii, redactText } from "@cognia/redact"
import type { InboundLabel, InboundLabelSeverity } from "@/types/connectors/inbound-label"

export const MAX_LABELS_PER_PLUGIN = 8
export const MAX_LABELS_PER_MESSAGE = 16
export const MAX_LABEL_NOTE_CHARS = 200
export const MAX_LABEL_TEXT_CHARS = 60

const KEY_RE = /^[a-z][a-z0-9_.-]{0,39}$/
const SEVERITIES: ReadonlySet<string> = new Set(["info", "warn", "high"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function severityForScore(score: number): InboundLabelSeverity {
  if (score >= 0.9) return "high"
  if (score >= 0.6) return "warn"
  return "info"
}

function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined
  const text = value.replace(/\s+/g, " ").trim().slice(0, max)
  return text || undefined
}

/** One plugin's raw `labels` array → accepted labels (possibly empty). */
export function normalizeInboundLabels(raw: unknown, source: string, at: number): InboundLabel[] {
  if (!Array.isArray(raw)) return []
  const out: InboundLabel[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (out.length >= MAX_LABELS_PER_PLUGIN) break
    if (!isRecord(item)) continue
    const key = typeof item.key === "string" ? item.key : ""
    if (!KEY_RE.test(key) || seen.has(key)) continue
    const score = typeof item.score === "number" ? item.score : Number.NaN
    if (!Number.isFinite(score) || score < 0 || score > 1) continue
    const severity =
      typeof item.severity === "string" && SEVERITIES.has(item.severity)
        ? (item.severity as InboundLabelSeverity)
        : severityForScore(score)
    const rawNote = cleanText(item.note, MAX_LABEL_NOTE_CHARS)
    const note = rawNote ? redactText(rawNote).redacted : undefined
    const labelKey = cleanText(item.labelKey, 80)
    seen.add(key)
    out.push({
      key,
      score: Math.round(score * 10_000) / 10_000,
      severity,
      label: cleanText(item.label, MAX_LABEL_TEXT_CHARS) ?? key,
      ...(labelKey ? { labelKey } : {}),
      ...(note && hasNoLeakingPii(note) ? { note } : {}),
      source,
      at,
    })
  }
  return out
}

/** All plugins' labels for one message, in dispatch order, capped. */
export function capInboundLabels(labels: readonly InboundLabel[]): InboundLabel[] {
  return labels.slice(0, MAX_LABELS_PER_MESSAGE)
}

/** Type guard for persisted metadata read back from storage / sync. */
export function readInboundLabels(value: unknown): InboundLabel[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (item): item is InboundLabel =>
      isRecord(item) &&
      typeof item.key === "string" &&
      typeof item.score === "number" &&
      typeof item.label === "string" &&
      typeof item.source === "string" &&
      SEVERITIES.has(String(item.severity))
  )
}
