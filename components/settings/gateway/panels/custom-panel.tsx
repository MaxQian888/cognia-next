"use client"

import { useTranslations } from "next-intl"
import { FileSlidersIcon } from "lucide-react"

import { StructuredConfigEditor } from "@/components/common/structured-config-editor"
import { parseGatewayConfig } from "@/lib/gateway/config-schema"

import type { GatewayPanelContext } from "../gateway-section"
import { GatewayPanelSection } from "../shared/panel-section"

/**
 * Settings → Gateway → Custom — the whole `GatewayConfig` as one validated
 * JSON/YAML document. Bind-time edits made here surface in the section-level
 * restart banner like any other, so this panel carries no restart state.
 */
export function GatewayCustomPanel({ ctx }: { ctx: GatewayPanelContext }) {
  const t = useTranslations("settings.gateway")

  return (
    <GatewayPanelSection
      icon={<FileSlidersIcon className="size-4" />}
      title={t("customHeading")}
      description={t("customHelp")}
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
