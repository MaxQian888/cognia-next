"use client"

/**
 * Settings → Gateway → Reliability — the request-time failover policy.
 *
 * Every field here is read live on each request, so unlike the listener panel
 * nothing needs a restart; the card says so rather than leaving the user to
 * guess from the absence of a warning.
 */

import { useTranslations } from "next-intl"

import { Label } from "@/components/ui/label"

import { ChipInput } from "../shared/chip-input"
import { NumberRow } from "../../common/number-row"
import type { GatewayPanelContext } from "../gateway-section"
import { GatewayPanelSection } from "../shared/panel-section"

export interface GatewayReliabilityPanelProps {
  ctx: GatewayPanelContext
}

export function GatewayReliabilityPanel({ ctx }: GatewayReliabilityPanelProps) {
  const t = useTranslations("settings.gateway")
  const { config, persist } = ctx

  return (
    <GatewayPanelSection
      title={t("reliabilityHeading")}
      description={t("reliabilityHelp")}
      badge={t("liveBadge")}
      badgeVariant="secondary"
    >
      <NumberRow
        id="gw-rate-limit"
        label={t("rateLimit")}
        help={t("rateLimitHelp")}
        value={config.rateLimitPerMin}
        min={1}
        max={60000}
        onCommit={(v) => void persist({ rateLimitPerMin: v })}
      />
      <NumberRow
        id="gw-connect-timeout"
        label={t("connectTimeout")}
        help={t("connectTimeoutHelp")}
        value={config.connectTimeoutSecs}
        min={1}
        max={600}
        onCommit={(v) => void persist({ connectTimeoutSecs: v })}
      />
      <NumberRow
        id="gw-request-timeout"
        label={t("requestTimeout")}
        help={t("requestTimeoutHelp")}
        value={config.requestTimeoutSecs}
        min={0}
        max={3600}
        onCommit={(v) => void persist({ requestTimeoutSecs: v })}
      />
      <NumberRow
        id="gw-max-retries"
        label={t("maxRetries")}
        help={t("maxRetriesHelp")}
        value={config.maxRetries}
        min={0}
        max={20}
        onCommit={(v) => void persist({ maxRetries: v })}
      />

      <div className="space-y-2">
        <Label>{t("retryStatusCodes")}</Label>
        <ChipInput
          values={config.retryStatusCodes.map(String)}
          onCommit={(next) =>
            void persist({
              retryStatusCodes: next
                .map((s) => Number.parseInt(s, 10))
                .filter((n) => Number.isFinite(n) && n >= 100 && n <= 599),
            })
          }
          placeholder={t("retryStatusCodesPlaceholder")}
          ariaLabel={t("retryStatusCodes")}
          addLabel={t("add")}
          removeLabel={t("remove")}
        />
        <p className="text-xs text-muted-foreground">{t("retryStatusCodesHelp")}</p>
      </div>
    </GatewayPanelSection>
  )
}
