"use client"

// Read-only Provider Profile Store surface (ADR-0090 Phase 1): shows the
// derived provider → deployment → transport chain for a legacy provider id,
// so users can see how the unified execution layer will address this row.
// Credentials are shown as reference KINDS only — never values.

import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { getDb } from "@/lib/db/schema"

export interface DeploymentProfileCardProps {
  /** The legacy provider id whose derived chain is displayed. */
  providerId: string
}

export function DeploymentProfileCard({ providerId }: DeploymentProfileCardProps) {
  const t = useTranslations("providers")

  const deployment = useLiveQuery(
    () => getDb().deploymentProfiles.where("legacyProviderId").equals(providerId).first(),
    [providerId]
  )
  const provider = useLiveQuery(
    () => (deployment ? getDb().providerProfiles.get(deployment.providerRef) : undefined),
    [deployment?.providerRef]
  )
  const transport = useLiveQuery(
    () => (deployment ? getDb().transportProfiles.get(deployment.transportProfileRef) : undefined),
    [deployment?.transportProfileRef]
  )

  if (!deployment) return null

  const isRelay = deployment.providerRef !== deployment.id
  const credentialKind = deployment.credentialProfileRef?.kind

  return (
    <div
      data-testid="deployment-profile-card"
      className="rounded-md border border-border/60 bg-muted/30 p-3 text-xs space-y-1.5"
    >
      <div className="flex items-center gap-2">
        <span className="font-medium">{t("deploymentProfileTitle")}</span>
        {isRelay ? (
          <Badge variant="outline">
            {t("deploymentProfileVendorOf", {
              vendor: provider?.displayName ?? deployment.providerRef,
            })}
          </Badge>
        ) : null}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-muted-foreground">
        <dt>{t("deploymentProfileEndpoint")}</dt>
        <dd className="truncate font-mono">{deployment.endpoint}</dd>
        <dt>{t("deploymentProfileTransport")}</dt>
        <dd className="font-mono">
          {transport
            ? `${transport.protocol} · ${transport.auth.scheme}`
            : deployment.transportProfileRef}
        </dd>
        {credentialKind ? (
          <>
            <dt>{t("deploymentProfileCredential")}</dt>
            <dd>{t(`deploymentProfileCredentialKind_${credentialKind.replace(/-/g, "_")}`)}</dd>
          </>
        ) : null}
      </dl>
    </div>
  )
}
