"use client"

/**
 * Session conversion fidelity report (ADR-0090 Phase 8).
 *
 * Renders a `SessionLossReport` honestly: the five-level fidelity badge with
 * its meaning, a provenance marker for rebuilt records, and every loss entry
 * by kind. An unsupported conversion is shown as unsupported, never dressed
 * up as success.
 *
 * `reverseFidelity` labels the OTHER direction, writing a canonical session
 * back out as a new native runtime session. `SessionCodec.materialize` is
 * declared by the claude-code and pi codecs and has no runtime caller anywhere
 * in the app (only the conformance suite exercises it), so the honest label is
 * "defined, not yet available here" rather than silence. Dormancy that is only
 * true in a type is indistinguishable from a bug six months later.
 *
 * The arrangement is shared with plugin conversion and the migration wizard
 * through `FidelitySummary`. This component keeps its own props, its own
 * `sessionImport.fidelityReport` namespace and every `data-testid`, because it
 * also renders inside the chat header's tooltip
 * (`components/chat/imported-origin-chip.tsx`).
 */

import { useTranslations } from "next-intl"

import { FidelitySummary, type FidelityBadgeVariant } from "@/components/common/fidelity-summary"
import type {
  CanonicalSessionHeader,
  SessionLossReport,
} from "@cognia/agent-config-types/canonical-session"

export interface FidelityReportProps {
  loss: SessionLossReport
  /**
   * The source codec's `materialize.fidelity`, when it declares one. Omitted =
   * an honest import-only source with no reverse direction at all.
   */
  reverseFidelity?: SessionLossReport["fidelity"]
  sessionHeader?: Pick<
    CanonicalSessionHeader,
    "source" | "runtimeBinding" | "lineage" | "lifecycle"
  >
}

const BADGE_VARIANT: Record<SessionLossReport["fidelity"], FidelityBadgeVariant> = {
  "native-exact": "default",
  structured: "secondary",
  contextual: "secondary",
  "summary-only": "outline",
  unsupported: "destructive",
}

export function FidelityReport({ loss, reverseFidelity, sessionHeader }: FidelityReportProps) {
  const t = useTranslations("sessionImport.fidelityReport")

  const badges = [
    {
      id: "fidelity",
      label: t(`fidelity.${loss.fidelity}`),
      variant: BADGE_VARIANT[loss.fidelity],
      testId: "fidelity-badge",
    },
    ...(loss.rebuilt
      ? [
          {
            id: "rebuilt",
            label: t("rebuilt"),
            variant: "outline" as const,
            testId: "rebuilt-badge",
          },
        ]
      : []),
  ]

  const hints = [t(`fidelityHint.${loss.fidelity}`), ...(loss.rebuilt ? [t("rebuiltHint")] : [])]

  const meta = (
    <>
      {sessionHeader && (
        <dl className="grid grid-cols-1 gap-x-2 gap-y-1 text-muted-foreground sm:grid-cols-[auto_1fr]">
          {sessionHeader.source?.version && (
            <>
              <dt>{t("sourceVersion")}</dt>
              <dd className="min-w-0 break-all" data-testid="source-version">
                {sessionHeader.source.version}
              </dd>
            </>
          )}
          {sessionHeader.lineage?.kind && (
            <>
              <dt>{t("relationship")}</dt>
              <dd className="min-w-0 break-all" data-testid="session-relationship">
                {t(`relationships.${sessionHeader.lineage.kind}`)}
                {sessionHeader.lineage.parentCanonicalSessionId
                  ? ` · ${sessionHeader.lineage.parentCanonicalSessionId}`
                  : ""}
              </dd>
            </>
          )}
          {sessionHeader.lifecycle?.status && (
            <>
              <dt>{t("lifecycle")}</dt>
              <dd className="min-w-0 break-all" data-testid="session-lifecycle">
                {t(`lifecycleStatuses.${sessionHeader.lifecycle.status}`)}
                {sessionHeader.lifecycle.background ? ` · ${t("background")}` : ""}
              </dd>
            </>
          )}
          <dt>{t("recoverability")}</dt>
          <dd className="min-w-0 break-all" data-testid="session-recoverability">
            {sessionHeader.runtimeBinding?.nativeSessionId && sessionHeader.runtimeBinding.presetId
              ? t("nativeResumeCandidate", { preset: sessionHeader.runtimeBinding.presetId })
              : t("readOnlyMirror")}
          </dd>
        </dl>
      )}
      {reverseFidelity && (
        <p className="text-muted-foreground" data-testid="reverse-dormant">
          {t("reverseDormant", { fidelity: t(`fidelity.${reverseFidelity}`) })}
        </p>
      )}
    </>
  )

  return (
    <FidelitySummary
      testId="fidelity-report"
      title={t("title")}
      badges={badges}
      hints={hints}
      meta={meta}
      entries={loss.losses.map((entry, index) => ({
        id: `${entry.path}-${index}`,
        path: entry.path,
        label: t(`lossKinds.${entry.kind}`),
        detail: entry.detail,
      }))}
      emptyLabel={t("noLosses")}
      emptyTestId="no-losses"
      countLabel={t("lossCount", { count: loss.losses.length })}
      countTestId="loss-count"
    />
  )
}
