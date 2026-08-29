"use client"

/**
 * Session conversion fidelity report (ADR-0090 Phase 8).
 *
 * Renders a `SessionLossReport` honestly: the five-level fidelity badge with
 * its meaning, a provenance marker for rebuilt records, and every loss entry
 * by kind. An unsupported conversion is shown as unsupported — never dressed
 * up as success.
 *
 * `reverseFidelity` labels the OTHER direction — writing a canonical session
 * back out as a new native runtime session. `SessionCodec.materialize` is
 * declared by the claude-code and pi codecs and has no runtime caller anywhere
 * in the app (only the conformance suite exercises it), so the honest label is
 * "defined, not yet available here" rather than silence. Dormancy that is only
 * true in a type is indistinguishable from a bug six months later.
 */

import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
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

const BADGE_VARIANT: Record<
  SessionLossReport["fidelity"],
  "default" | "secondary" | "outline" | "destructive"
> = {
  "native-exact": "default",
  structured: "secondary",
  contextual: "secondary",
  "summary-only": "outline",
  unsupported: "destructive",
}

export function FidelityReport({ loss, reverseFidelity, sessionHeader }: FidelityReportProps) {
  const t = useTranslations("sessionImport.fidelityReport")

  return (
    <div className="space-y-2 text-xs" data-testid="fidelity-report">
      <div className="flex items-center gap-2">
        <span className="font-medium">{t("title")}</span>
        <Badge variant={BADGE_VARIANT[loss.fidelity]} data-testid="fidelity-badge">
          {t(`fidelity.${loss.fidelity}`)}
        </Badge>
        {loss.rebuilt && (
          <Badge variant="outline" data-testid="rebuilt-badge">
            {t("rebuilt")}
          </Badge>
        )}
      </div>
      <p className="text-muted-foreground">{t(`fidelityHint.${loss.fidelity}`)}</p>
      {loss.rebuilt && <p className="text-muted-foreground">{t("rebuiltHint")}</p>}
      {sessionHeader && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-muted-foreground">
          {sessionHeader.source?.version && (
            <>
              <dt>{t("sourceVersion")}</dt>
              <dd data-testid="source-version">{sessionHeader.source.version}</dd>
            </>
          )}
          {sessionHeader.lineage?.kind && (
            <>
              <dt>{t("relationship")}</dt>
              <dd data-testid="session-relationship">
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
              <dd data-testid="session-lifecycle">
                {t(`lifecycleStatuses.${sessionHeader.lifecycle.status}`)}
                {sessionHeader.lifecycle.background ? ` · ${t("background")}` : ""}
              </dd>
            </>
          )}
          <dt>{t("recoverability")}</dt>
          <dd data-testid="session-recoverability">
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
      {loss.losses.length === 0 ? (
        <p className="text-muted-foreground" data-testid="no-losses">
          {t("noLosses")}
        </p>
      ) : (
        <div className="space-y-1">
          <p className="text-muted-foreground" data-testid="loss-count">
            {t("lossCount", { count: loss.losses.length })}
          </p>
          <ul className="list-disc space-y-0.5 pl-4">
            {loss.losses.map((entry, index) => (
              <li key={`${entry.path}-${index}`} className="text-muted-foreground">
                <span className="font-mono">{entry.path}</span> — {t(`lossKinds.${entry.kind}`)}
                {entry.detail ? `: ${entry.detail}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
