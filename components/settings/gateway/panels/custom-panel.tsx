"use client"

import { useTranslations } from "next-intl"
import { FileSlidersIcon } from "lucide-react"

import { StructuredConfigEditor } from "@/components/common/structured-config-editor"
import { parseGatewayConfig } from "@/lib/gateway/config-schema"

import type { GatewayPanelContext } from "../gateway-section"
import { GatewayPanelSection } from "../shared/panel-section"

export function GatewayCustomPanel({ ctx }: { ctx: GatewayPanelContext }) {
  const t = useTranslations("settings.gateway")

  return (
    <GatewayPanelSection
      icon={<FileSlidersIcon className="size-4" />}
      title={t("customHeading")}
      description={t("customHelp")}
      badge={ctx.restartRequired ? t("restartRequiredBadge") : undefined}
      badgeVariant={ctx.restartRequired ? "destructive" : "secondary"}
    >
      <StructuredConfigEditor
        value={ctx.config}
        validate={parseGatewayConfig}
        onApply={ctx.replace}
        filename="cognia-gateway"
      />
    </GatewayPanelSection>
  )
}
