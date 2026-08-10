"use client"

/**
 * Settings → Gateway → Model exposure — which model ids `/v1/models` advertises
 * and the gateway will serve.
 */

import { useTranslations } from "next-intl"

import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"

import { ChipInput } from "../shared/chip-input"
import type { GatewayPanelContext } from "../gateway-section"
import { GatewayPanelSection } from "../shared/panel-section"

export interface GatewayExposurePanelProps {
  ctx: GatewayPanelContext
}

export function GatewayExposurePanel({ ctx }: GatewayExposurePanelProps) {
  const t = useTranslations("settings.gateway")
  const { config, persist } = ctx

  return (
    <GatewayPanelSection
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

      <Field orientation="responsive">
        <FieldContent>
          <FieldLabel htmlFor="gw-hide-raw">{t("hideRawModels")}</FieldLabel>
          <FieldDescription>{t("hideRawModelsHelp")}</FieldDescription>
        </FieldContent>
        <Switch
          id="gw-hide-raw"
          checked={config.hideRawProviderModels}
          onCheckedChange={(value) => void persist({ hideRawProviderModels: value })}
        />
      </Field>
    </GatewayPanelSection>
  )
}
