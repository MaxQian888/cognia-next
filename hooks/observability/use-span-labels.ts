"use client"

/**
 * Translated display labels for the agent-trace enums — operation, surface,
 * span kind — with the raw identifier kept for a secondary line or `title`.
 *
 * The span schema stores OTel identifiers (`invoke_agent`, `execute_tool`,
 * `agent-team`, `plugin-hook`, …) and the Traces channel used to print them
 * verbatim in every badge, lane label and hover card: correct, greppable, and
 * untranslatable — a zh-CN user read `execute_tool` next to a fully localized
 * pane. The identifier is still the thing a user searches for and pastes into
 * a bug report, so it is never thrown away: components render `label(value)`
 * as the text and `value` itself as the `title` / secondary text.
 *
 * Open-ended values degrade to themselves. `SpanSurface` and the operation
 * enum are closed today, but rows written by a newer build (or a plugin
 * emitting a custom surface) must still render — `t.has` gates every lookup,
 * so an unknown id shows as the id instead of as a missing-message key.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"

export type SpanEnumKind = "operation" | "surface" | "spanKind"

export interface SpanLabels {
  /** `invoke_agent` → "Agent run" (or the id itself when unknown). */
  operation: (value: string) => string
  /** `agent-team` → "Agent team". */
  surface: (value: string) => string
  /** `client` → "Client". */
  spanKind: (value: string) => string
  /** Generic form, for callers that hold the kind as data (lane grouping). */
  label: (kind: SpanEnumKind, value: string) => string
}

/**
 * Message keys may not contain `.`; OTel ids use `_` and `-`, which are safe,
 * but a custom surface could carry anything, so anything else is escaped
 * before it reaches `t.has` (which would otherwise read it as a path).
 */
function messageKey(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_")
}

export function useSpanLabels(): SpanLabels {
  const t = useTranslations("observability.enums")
  return useMemo<SpanLabels>(() => {
    const label = (kind: SpanEnumKind, value: string): string => {
      if (!value) return value
      const key = `${kind}.${messageKey(value)}`
      return t.has(key) ? t(key) : value
    }
    return {
      label,
      operation: (value) => label("operation", value),
      surface: (value) => label("surface", value),
      spanKind: (value) => label("spanKind", value),
    }
  }, [t])
}

/**
 * Label function for one breakdown / filter dimension: the enum-backed ones
 * (`operation`, `surface`) translate, every other dimension (model, tool,
 * provider, project, session) is free-form data and renders as itself.
 */
export function useBreakdownLabel(dimension: string | undefined): (value: string) => string {
  const labels = useSpanLabels()
  return useMemo(() => {
    if (dimension === "operation") return labels.operation
    if (dimension === "surface") return labels.surface
    return (value: string) => value
  }, [dimension, labels])
}
