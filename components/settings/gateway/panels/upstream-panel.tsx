"use client"

/**
 * Settings → Gateway → Upstream protection.
 *
 * The controls that keep a failing or rate-limited upstream account from being
 * hammered: in-flight concurrency caps (W1.2), per-key cooldowns (W1.1), the
 * permanent-disable keyword list (W3.1), outbound field stripping (W3.2), and
 * the SSE idle timeout.
 *
 * The parked-key list also renders each row's `reason` and counts its recovery
 * down live. Both were already returned by `gateway_list_cooldowns`: `reason`
 * was dropped on the floor, and the recovery time was a static timestamp behind
 * a manual refresh button, so a cooldown that had already lifted still looked
 * active until the user clicked.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { RefreshCwIcon, ShieldIcon } from "lucide-react"

import { MotionReveal } from "@/components/chat/motion/motion-reveal"
import { SettingsEmptyState } from "@/components/settings/common/settings-section"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item"
import { Label } from "@/components/ui/label"
import type { GatewayKeyCooldown } from "@/types/gateway"

import { ChipInput } from "../shared/chip-input"
import { NumberRow } from "../../common/number-row"
import type { GatewayPanelContext } from "../gateway-section"
import { GatewayPanelSection, GatewayPanelStack } from "../shared/panel-section"

export interface GatewayUpstreamPanelProps {
  ctx: GatewayPanelContext
  cooldowns: GatewayKeyCooldown[]
  onRefreshCooldowns: () => Promise<void>
}

export function GatewayUpstreamPanel({
  ctx,
  cooldowns,
  onRefreshCooldowns,
}: GatewayUpstreamPanelProps) {
  const t = useTranslations("settings.gateway")
  const { config, persist } = ctx

  return (
    <GatewayPanelStack>
      <GatewayPanelSection
        icon={<ShieldIcon className="size-4" />}
        title={t("concurrencyHeading")}
        description={t("concurrencyHelp")}
        badge={t("liveBadge")}
        badgeVariant="secondary"
      >
        <NumberRow
          id="gw-cc-per-key"
          label={t("maxConcurrentPerKey")}
          help={t("maxConcurrentPerKeyHelp")}
          value={config.maxConcurrentPerKey}
          min={0}
          max={1000}
          onCommit={(v) => void persist({ maxConcurrentPerKey: v })}
        />
        <NumberRow
          id="gw-cc-per-upstream"
          label={t("maxConcurrentPerUpstreamKey")}
          help={t("maxConcurrentPerUpstreamKeyHelp")}
          value={config.maxConcurrentPerUpstreamKey}
          min={0}
          max={1000}
          onCommit={(v) => void persist({ maxConcurrentPerUpstreamKey: v })}
        />
        <NumberRow
          id="gw-cc-wait"
          label={t("concurrencyWait")}
          help={t("concurrencyWaitHelp")}
          value={config.concurrencyWaitMs}
          min={0}
          max={120000}
          onCommit={(v) => void persist({ concurrencyWaitMs: v })}
        />
        <NumberRow
          id="gw-stream-idle"
          label={t("streamIdleTimeout")}
          help={t("streamIdleTimeoutHelp")}
          value={config.streamIdleTimeoutSecs}
          min={0}
          max={3600}
          onCommit={(v) => void persist({ streamIdleTimeoutSecs: v })}
        />
      </GatewayPanelSection>

      <GatewayPanelSection title={t("cooldownHeading")} description={t("cooldownHelp")}>
        <NumberRow
          id="gw-cooldown-fallback"
          label={t("cooldownFallback")}
          help={t("cooldownFallbackHelp")}
          value={config.cooldownFallbackSecs}
          min={0}
          max={3600}
          onCommit={(v) => void persist({ cooldownFallbackSecs: v })}
        />
        <NumberRow
          id="gw-overload-cooldown"
          label={t("overloadCooldown")}
          help={t("overloadCooldownHelp")}
          value={config.overloadCooldownSecs}
          min={0}
          max={3600}
          onCommit={(v) => void persist({ overloadCooldownSecs: v })}
        />

        <div className="space-y-2">
          <Label>{t("disableKeywords")}</Label>
          <ChipInput
            values={config.disableKeywords}
            onCommit={(next) => void persist({ disableKeywords: next })}
            placeholder={t("disableKeywordsPlaceholder")}
            ariaLabel={t("disableKeywords")}
            addLabel={t("add")}
            removeLabel={t("remove")}
          />
          <p className="text-xs text-muted-foreground">{t("disableKeywordsHelp")}</p>
        </div>
      </GatewayPanelSection>

      <GatewayPanelSection
        title={t("cooldownsHeading")}
        description={t("cooldownsHelp")}
        action={
          <Button
            size="sm"
            variant="outline"
            onClick={() => void onRefreshCooldowns()}
            data-testid="gateway-cooldowns-refresh"
          >
            <RefreshCwIcon className="mr-1.5 size-3.5" aria-hidden />
            {t("cooldownsRefresh")}
          </Button>
        }
      >
        {cooldowns.length === 0 ? (
          <SettingsEmptyState
            icon={<ShieldIcon className="size-5" />}
            title={t("cooldownsEmpty")}
            className="py-6"
          />
        ) : (
          <ItemGroup data-testid="gateway-cooldowns">
            {cooldowns.map((c, index) => (
              <MotionReveal key={`${c.providerId}-${c.keyHint}`} index={index}>
                <Item role="listitem" size="sm" variant="muted">
                  <ItemContent className="min-w-0">
                    <ItemTitle className="truncate font-mono text-xs">
                      {c.providerId} · {c.keyHint}
                    </ItemTitle>
                    {c.reason && (
                      <ItemDescription
                        className="line-clamp-none text-[11px]"
                        data-testid={`gateway-cooldown-reason-${c.providerId}`}
                      >
                        {c.reason}
                      </ItemDescription>
                    )}
                  </ItemContent>
                  {c.permanent ? (
                    <Badge variant="destructive" className="shrink-0">
                      {t("cooldownsPermanent")}
                    </Badge>
                  ) : (
                    <CooldownCountdown untilMs={c.untilMs} />
                  )}
                </Item>
              </MotionReveal>
            ))}
          </ItemGroup>
        )}
      </GatewayPanelSection>

      <GatewayPanelSection title={t("fieldStripHeading")} description={t("fieldStripHelp")}>
        <div className="space-y-2">
          <Label>{t("strippedFields")}</Label>
          <ChipInput
            values={config.strippedRequestFields}
            onCommit={(next) => void persist({ strippedRequestFields: next })}
            placeholder={t("strippedFieldsPlaceholder")}
            ariaLabel={t("strippedFields")}
            addLabel={t("add")}
            removeLabel={t("remove")}
          />
          <p className="text-xs text-muted-foreground">{t("strippedFieldsHelp")}</p>
        </div>

        <div className="space-y-2">
          <Label>{t("fieldStripAllow")}</Label>
          <ChipInput
            values={config.fieldStripAllow}
            onCommit={(next) => void persist({ fieldStripAllow: next })}
            placeholder={t("fieldStripAllowPlaceholder")}
            ariaLabel={t("fieldStripAllow")}
            addLabel={t("add")}
            removeLabel={t("remove")}
          />
          <p className="text-xs text-muted-foreground">{t("fieldStripAllowHelp")}</p>
        </div>
      </GatewayPanelSection>
    </GatewayPanelStack>
  )
}

/**
 * Live "recovers in Xs" for one parked key.
 *
 * Isolated into its own component so the once-a-second tick re-renders a single
 * `<span>` rather than the whole panel — the list sits beside a dozen
 * controlled inputs whose draft state must not be disturbed.
 */
export function CooldownCountdown({ untilMs }: { untilMs: number }) {
  const t = useTranslations("settings.gateway")
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const remainingMs = untilMs - now
  if (remainingMs <= 0) {
    return (
      <Badge variant="outline" className="shrink-0" data-testid="gateway-cooldown-recovered">
        {t("cooldownsRecovered")}
      </Badge>
    )
  }

  return (
    <Badge
      variant="secondary"
      className="shrink-0 tabular-nums"
      data-testid="gateway-cooldown-remaining"
    >
      {t("cooldownsRecoversIn", { seconds: Math.ceil(remainingMs / 1000) })}
    </Badge>
  )
}
