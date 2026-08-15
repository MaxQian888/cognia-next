"use client"

// Read-only certification status for one deployment (ADR-0090 Phase 5):
// evidence level, capability table, staleness, bundle id, rollback hint.
// Pure display over the Dexie projection — activation/rollback are admin
// operations (scripts/certify), never a click here.

import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { PINNED_RUNTIME_VERSIONS } from "@cognia/agent-config-types/runtime-versions"
import { computeStaleness } from "@/lib/ai/agent/execution/staleness"
import { getDb } from "@/lib/db/schema"

export interface DeploymentCertificationPanelProps {
  deploymentRef: string
  /** Sidecar-reported embedded Claude Code version ("unknown" until ready). */
  claudeCodeVersion?: string
  suiteVersion?: string
}

export function DeploymentCertificationPanel({
  deploymentRef,
  // Default to the pinned runtime versions the certification records are
  // keyed with. The previous defaults ("unknown" / "1") never matched a real
  // record, so every legitimately certified bundle rendered as stale on the
  // Claude Code and suite axes.
  claudeCodeVersion = PINNED_RUNTIME_VERSIONS.claudeCodeVersion,
  suiteVersion = PINNED_RUNTIME_VERSIONS.certificationSuiteVersion,
}: DeploymentCertificationPanelProps) {
  const t = useTranslations("providers")
  const records = useLiveQuery(
    () => getDb().agentCompatibilityRecords.where("deploymentRef").equals(deploymentRef).toArray(),
    [deploymentRef]
  )

  if (!records || records.length === 0) return null

  const current = {
    agentSdkVersion: PINNED_RUNTIME_VERSIONS.agentSdkVersion,
    gatewayVersion: PINNED_RUNTIME_VERSIONS.gatewayCrateVersion,
    claudeCodeVersion,
    suiteVersion,
  }

  return (
    <div
      data-testid="deployment-certification-panel"
      className="rounded-md border border-border/60 p-3 space-y-2 text-xs"
    >
      <div className="font-medium">{t("certificationTitle")}</div>
      {records.map((record) => {
        const staleness = computeStaleness(record.manifest, current)
        return (
          <div
            key={record.keyId}
            className="space-y-1 border-t border-border/40 pt-2 first:border-t-0 first:pt-0"
          >
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">
                {t(`certificationEvidence_${record.evidence.replace(/-/g, "_")}`)}
              </Badge>
              <Badge variant="outline">{record.level}</Badge>
              {staleness.stale ? (
                <Badge variant="outline" className="border-destructive/60 text-destructive">
                  {t("certificationStale")}
                </Badge>
              ) : (
                <Badge variant="outline" className="border-emerald-500/60 text-emerald-600">
                  {t("certificationFresh")}
                </Badge>
              )}
              <span className="text-muted-foreground font-mono">{record.bundleId}</span>
            </div>
            {staleness.stale ? (
              <ul className="text-muted-foreground list-disc pl-4">
                {staleness.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            ) : null}
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-muted-foreground">
              {Object.entries(record.manifest.capabilities).map(([capability, support]) => (
                <div key={capability} className="contents">
                  <dt className="font-mono">{capability}</dt>
                  <dd>{t(`certificationSupport_${support}`)}</dd>
                </div>
              ))}
            </dl>
            {staleness.stale ? (
              <p className="text-muted-foreground">{t("certificationRollbackHint")}</p>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
