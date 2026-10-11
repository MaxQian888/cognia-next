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
import { UNKNOWN_MODEL } from "@/lib/observability/model-key"

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
  /**
   * A span's display name: the tool for a tool call, "<operation> · <agent>"
   * for an agent span, the operation otherwise — the same shape as the raw
   * `spanLabel` in `trace-rollup`, with the operation translated. The trace
   * list and the waterfall printed `invoke_agent · Planner` beside a legend
   * that already said "Agent run".
   */
  spanName: (span: SpanNameParts) => string
}

/** The fields a span's display name is made of. */
export interface SpanNameParts {
  operationName: string
  agentName?: string
  toolName?: string
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
      spanName: ({ operationName, agentName, toolName }) => {
        if (operationName === "execute_tool" && toolName) return toolName
        const operation = label("operation", operationName)
        return agentName ? `${operation} · ${agentName}` : operation
      },
      operation: (value) => label("operation", value),
      surface: (value) => label("surface", value),
      spanKind: (value) => label("spanKind", value),
    }
  }, [t])
}

/**
 * Label function for one breakdown / filter dimension: the enum-backed ones
 * (`operation`, `surface`) translate, every other dimension (model, tool,
 * provider, project, session) is free-form data and renders as itself —
 * except the model sentinel. Agent-run and tool-call spans carry no model at
 * all, and they bucketed under a hard-coded English "(unknown)" that was the
 * biggest slice of the by-model donut in either locale. The key stays the
 * sentinel (filters and series bucket on it); only the label says what the
 * spans are.
 */
export function useBreakdownLabel(dimension: string | undefined): (value: string) => string {
  const labels = useSpanLabels()
  const noModel = useTranslations("observability.enums")("model.none")
  return useMemo(
    () =>
      (value: string): string => {
        if (dimension === "operation") return labels.operation(value)
        if (dimension === "surface") return labels.surface(value)
        if (dimension === "model" && value === UNKNOWN_MODEL) return noModel
        return value
      },
    [dimension, labels, noModel]
  )
}
