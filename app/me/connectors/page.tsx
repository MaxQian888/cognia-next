"use client"

import { useTranslations } from "next-intl"

import { SubPageShell } from "@/components/mobile/me/sub-page-shell"
import { ConnectorPolicyList } from "@/components/mobile/connector/connector-policy-list"
import { ConnectionsSection } from "@/components/settings/connections/connections-section"

export default function MobileConnectorsPage() {
  const t = useTranslations("mobile.me")
  return (
    <SubPageShell
      title={t("connectorsRow")}
      backAria={t("appearanceBackAria")}
      testid="mobile-connectors-page"
    >
      <div className="flex flex-col gap-4">
        <ConnectorPolicyList />
        <ConnectionsSection />
      </div>
    </SubPageShell>
  )
}
