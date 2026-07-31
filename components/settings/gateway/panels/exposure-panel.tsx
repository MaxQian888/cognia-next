"use client"

/**
 * Settings → Gateway → Model exposure — which model ids `/v1/models` advertises
 * and the gateway will serve.
 */

import { useTranslations } from "next-intl"

import { SettingsCard, SettingsToggle } from "@/components/settings/common/settings-section"
import { Label } from "@/components/ui/label"

import { ChipInput } from "../shared/chip-input"
import type { GatewayPanelContext } from "../gateway-section"

export interface GatewayExposurePanelProps {
  ctx: GatewayPanelContext
}

export function GatewayExposurePanel({ ctx }: GatewayExposurePanelProps) {
  const t = useTranslations("settings.gateway")
  const { config, persist } = ctx

  return (
    <div className="space-y-4">
      <SettingsCard
        title={t("exposureHeading")}
        description={t("exposureHelp")}
        badge={t("liveBadge")}
        badgeVariant="secondary"
      >
        <div className="space-y-2">
          <Label>{t("exposedModels")}</Label>
          <ChipInput
            values={config.exposedModels}
            onCommit={(next) => void persist({ exposedModels: next })}
            placeholder={t("exposedModelsPlaceholder")}
            ariaLabel={t("exposedModels")}
            addLabel={t("add")}
            removeLabel={t("remove")}
          />
          <p className="text-xs text-muted-foreground">
            {config.exposedModels.length === 0 ? t("exposedModelsAll") : t("exposedModelsHelp")}
          </p>
        </div>

        <SettingsToggle
          id="gw-hide-raw"
          label={t("hideRawModels")}
          description={t("hideRawModelsHelp")}
          checked={config.hideRawProviderModels}
          onCheckedChange={(v) => void persist({ hideRawProviderModels: v })}
        />
      </SettingsCard>
    </div>
  )
}
