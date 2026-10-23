/**
 * Labels a plugin attaches to an inbound IM message without blocking it
 * (ADR-0194 §inbound annotation) — e.g. laya's observe-mode moderation scores.
 *
 * A plugin returns `{ action: "annotate", labels: InboundLabelInput[] }` from
 * `onConnectorInbound`; the host validates, caps and stamps them
 * (`lib/connectors/inbound-labels.ts`) and persists them on the message row as
 * `metadata.inboundLabels`, where the transcript renders them as chips.
 */

export type InboundLabelSeverity = "info" | "warn" | "high"

/** Keys the host translates itself; other keys use the plugin's label. */
export const KNOWN_INBOUND_LABEL_KEYS = ["spam", "toxic", "harassment", "threat"] as const
export type KnownInboundLabelKey = (typeof KNOWN_INBOUND_LABEL_KEYS)[number]

/** What a plugin returns. */
export interface InboundLabelInput {
  /** Lower-case id, e.g. `spam`. */
  key: string
  /** Strength, 0..1. */
  score: number
  /** Derived from the score when omitted (≥0.9 high, ≥0.6 warn). */
  severity?: InboundLabelSeverity
  /**
   * Literal display text. Required in practice for unknown keys: a paired
   * companion device renders labels without loading the plugin's bundle.
   */
  label?: string
  /** Plugin i18n key for `label` (`manifest.i18n.locales`). */
  labelKey?: string
  /** Short explanation shown on hover; PII-gated. */
  note?: string
}

/** What the host persists. */
export interface InboundLabel {
  key: string
  score: number
  severity: InboundLabelSeverity
  label: string
  labelKey?: string
  note?: string
  /** Plugin that produced the label. */
  source: string
  /** Epoch ms the host accepted it. */
  at: number
}
