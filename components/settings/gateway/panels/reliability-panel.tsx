"use client"

/**
 * Settings → Gateway → Reliability — timeouts, the failover walk, and which
 * routing engine plans it.
 *
 * Everything here is read live on each request except the connect timeout,
 * which sizes the upstream HTTP client when the listener binds. The panel used
 * to wear one "applies immediately" badge for all of it — including that
 * field, and the global rate limit (also bind-time, now on Listener).
 *
 * The backoff pair is bounded against each other in the inputs: Rust refuses
 * a config whose base exceeds its max, and that refusal used to arrive as a
 * generic "invalid config" toast with the field silently reverted.
 */

import { useTranslations } from "next-intl"
import { GitBranchIcon, RepeatIcon, TimerIcon } from "lucide-react"

import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"

import { ChipInput } from "../shared/chip-input"
import { BindTimeBadge } from "../shared/bind-time-badge"
import { NumberRow } from "../../common/number-row"
import type { GatewayPanelContext } from "../gateway-section"
import { GatewayPanelSection, GatewayPanelStack } from "../shared/panel-section"

const U32_MAX = 4_294_967_295

export interface GatewayReliabilityPanelProps {
  ctx: GatewayPanelContext
}

/** A retry status is an integer HTTP status in the 1xx–5xx range. */
export function isValidRetryStatus(value: string): boolean {
  if (!/^\d{3}$/.test(value)) return false
  const code = Number(value)
  return code >= 100 && code <= 599
}

export function GatewayReliabilityPanel({ ctx }: GatewayReliabilityPanelProps) {
  const t = useTranslations("settings.gateway")
  const { config, persist, pendingRestartFields } = ctx

  return (
    <GatewayPanelStack>
      <GatewayPanelSection
        icon={<TimerIcon className="size-4" />}
        title={t("timeoutsHeading")}
        description={t("timeoutsHelp")}
      >
        <NumberRow
          id="gw-connect-timeout"
          label={t("connectTimeout")}
          help={t("connectTimeoutHelp")}
          adornment={<BindTimeBadge field="connectTimeoutSecs" pending={pendingRestartFields} />}
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
      </GatewayPanelSection>

      <GatewayPanelSection
        icon={<RepeatIcon className="size-4" />}
        title={t("reliabilityHeading")}
        description={t("reliabilityHelp")}
        badge={t("liveBadge")}
        badgeVariant="secondary"
      >
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
            onCommit={(next) => void persist({ retryStatusCodes: next.map(Number) })}
            validate={(value) => (isValidRetryStatus(value) ? null : t("retryStatusCodesInvalid"))}
            placeholder={t("retryStatusCodesPlaceholder")}
            ariaLabel={t("retryStatusCodes")}
            addLabel={t("add")}
            removeLabel={t("remove")}
          />
          <p className="text-xs text-muted-foreground">{t("retryStatusCodesHelp")}</p>
        </div>

        <NumberRow
          id="gw-retry-backoff-base"
          label={t("retryBackoffBase")}
          help={t("retryBackoffBaseHelp")}
          value={config.retryBackoffBaseMs}
          min={0}
          max={config.retryBackoffMaxMs}
          onCommit={(v) => void persist({ retryBackoffBaseMs: v })}
        />
        <NumberRow
          id="gw-retry-backoff-max"
          label={t("retryBackoffMax")}
          help={t("retryBackoffMaxHelp")}
          value={config.retryBackoffMaxMs}
          min={config.retryBackoffBaseMs}
          max={U32_MAX}
          onCommit={(v) => void persist({ retryBackoffMaxMs: v })}
        />
        <NumberRow
          id="gw-max-retry-wait"
          label={t("maxRetryWait")}
          help={t("maxRetryWaitHelp")}
          value={config.maxRetryWaitMs}
          min={0}
          max={U32_MAX}
          onCommit={(v) => void persist({ maxRetryWaitMs: v })}
        />

        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="gw-respect-retry-after">{t("respectRetryAfter")}</FieldLabel>
            <FieldDescription>{t("respectRetryAfterHelp")}</FieldDescription>
          </FieldContent>
          <Switch
            id="gw-respect-retry-after"
            checked={config.respectRetryAfter}
            onCheckedChange={(checked) => void persist({ respectRetryAfter: checked })}
          />
        </Field>
      </GatewayPanelSection>

      <GatewayPanelSection
        icon={<GitBranchIcon className="size-4" />}
        title={t("routingEngineHeading")}
        description={t("routingEngineHelp")}
        badge={t("liveBadge")}
        badgeVariant="secondary"
      >
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="gw-local-routing-v2">{t("gatewayLocalRoutingV2")}</FieldLabel>
            <FieldDescription>{t("gatewayLocalRoutingV2Help")}</FieldDescription>
          </FieldContent>
          <Switch
            id="gw-local-routing-v2"
            checked={config.gatewayLocalRoutingV2}
            onCheckedChange={(checked) => void persist({ gatewayLocalRoutingV2: checked })}
          />
        </Field>
      </GatewayPanelSection>
    </GatewayPanelStack>
  )
}
