"use client"

/**
 * Settings → Gateway → Upstream protection.
 *
 * The controls that keep a failing or rate-limited upstream account from being
 * hammered: in-flight concurrency caps (W1.2), per-key cooldowns (W1.1), the
 * permanent-disable keyword list (W3.1), outbound field stripping (W3.2), and
 * the SSE idle timeout.
 *
 * The parked-key list renders each row's `reason` and counts its recovery down
 * live; when a countdown reaches zero it re-reads the list so the row (and the
 * nav badge) goes away instead of sitting on "recovered" until the next poll.
 * Rows are grouped per provider because that is the granularity
 * `gateway_reset_cooldowns` restores at — the command always took an optional
 * provider id, but only the restore-everything form was ever reachable.
 */

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { Loader2Icon, RefreshCwIcon, ShieldIcon } from "lucide-react"
import { toast } from "sonner"

import { MotionReveal } from "@/components/chat/motion/motion-reveal"
import { SettingsEmptyState } from "@/components/settings/common/settings-section"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item"
import { Label } from "@/components/ui/label"
import { useStableCallback } from "@/hooks/ui/use-stable-callback"
import { isValidFieldStripException } from "@/lib/gateway/config-schema"
import { gatewayResetCooldowns } from "@/lib/tauri/gateway"
import { cn } from "@/lib/utils"
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

/** `"refresh"`, `"reset:*"` (every provider) or `"reset:<providerId>"`. */
type CooldownAction = "refresh" | `reset:${string}`

const RESET_ALL: CooldownAction = "reset:*"

/** Parked rows grouped by provider, providers in first-seen order. */
export function groupCooldownsByProvider(
  cooldowns: readonly GatewayKeyCooldown[]
): Array<[string, GatewayKeyCooldown[]]> {
  const groups = new Map<string, GatewayKeyCooldown[]>()
  for (const row of cooldowns) {
    const rows = groups.get(row.providerId)
    if (rows) rows.push(row)
    else groups.set(row.providerId, [row])
  }
  return [...groups.entries()]
}

export function GatewayUpstreamPanel({
  ctx,
  cooldowns,
  onRefreshCooldowns,
}: GatewayUpstreamPanelProps) {
  const t = useTranslations("settings.gateway")
  const { config, persist } = ctx
  const [cooldownAction, setCooldownAction] = useState<CooldownAction | null>(null)
  const groups = useMemo(() => groupCooldownsByProvider(cooldowns), [cooldowns])

  async function refreshCooldowns() {
    try {
      await onRefreshCooldowns()
    } catch {
      toast.error(t("cooldownsRefreshFailed"))
    }
  }

  async function runCooldownAction(action: CooldownAction) {
    setCooldownAction(action)
    try {
      if (action !== "refresh") {
        const provider = action.slice("reset:".length)
        const count =
          provider === "*" ? await gatewayResetCooldowns() : await gatewayResetCooldowns(provider)
        toast.success(t("cooldownsResetSuccess", { count }))
      }
      await refreshCooldowns()
    } catch {
      toast.error(t("cooldownsResetFailed"))
    } finally {
      setCooldownAction(null)
    }
  }

  // A countdown reaching zero is Rust's cue to drop the row; re-read quietly.
  const onCooldownElapsed = useStableCallback(() => {
    void onRefreshCooldowns().catch(() => {})
  })

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

      <GatewayPanelSection
        title={t("cooldownHeading")}
        description={t("cooldownHelp")}
        badge={t("liveBadge")}
        badgeVariant="secondary"
      >
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
        badge={cooldowns.length > 0 ? String(cooldowns.length) : undefined}
        badgeVariant={cooldowns.some((c) => c.permanent) ? "destructive" : "secondary"}
        action={
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={cooldownAction !== null}
              onClick={() => void runCooldownAction("refresh")}
              data-testid="gateway-cooldowns-refresh"
            >
              <RefreshCwIcon
                className={cn("mr-1.5 size-3.5", cooldownAction === "refresh" && "animate-spin")}
                aria-hidden
              />
              {t("cooldownsRefresh")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={cooldownAction !== null || cooldowns.length === 0}
              onClick={() => void runCooldownAction(RESET_ALL)}
            >
              {cooldownAction === RESET_ALL && (
                <Loader2Icon className="mr-1.5 size-3.5 animate-spin" aria-hidden />
              )}
              {t(cooldownAction === RESET_ALL ? "cooldownsResetting" : "cooldownsReset")}
            </Button>
          </div>
        }
      >
        {cooldowns.length === 0 ? (
          <SettingsEmptyState
            icon={<ShieldIcon className="size-5" />}
            title={t("cooldownsEmpty")}
            className="py-6"
          />
        ) : (
          <div className="flex flex-col gap-3" data-testid="gateway-cooldowns">
            {groups.map(([providerId, rows], groupIndex) => {
              const action: CooldownAction = `reset:${providerId}`
              return (
                <MotionReveal key={providerId} index={groupIndex}>
                  <section
                    aria-label={providerId}
                    className="overflow-hidden rounded-md border"
                    data-testid={`gateway-cooldown-group-${providerId}`}
                  >
                    <div className="flex items-center justify-between gap-2 border-b bg-muted/40 px-3 py-1.5">
                      <span className="min-w-0 truncate font-mono text-xs font-medium">
                        {providerId}
                      </span>
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={cooldownAction !== null}
                        onClick={() => void runCooldownAction(action)}
                        aria-label={t("cooldownsRestoreProviderAria", { provider: providerId })}
                      >
                        {cooldownAction === action ? (
                          <Loader2Icon className="size-3 animate-spin" aria-hidden />
                        ) : null}
                        {t("cooldownsRestoreProvider")}
                      </Button>
                    </div>
                    <ItemGroup>
                      {rows.map((c) => (
                        <Item
                          key={`${c.providerId}-${c.keyHint}`}
                          role="listitem"
                          size="sm"
                          className="rounded-none"
                        >
                          <ItemContent className="min-w-0">
                            {/* The group header already names the provider. */}
                            <ItemTitle className="w-full truncate font-mono text-xs">
                              {c.keyHint}
                            </ItemTitle>
                            {c.reason && (
                              <ItemDescription
                                className="line-clamp-none break-words text-[11px]"
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
                            <CooldownCountdown untilMs={c.untilMs} onElapsed={onCooldownElapsed} />
                          )}
                        </Item>
                      ))}
                    </ItemGroup>
                  </section>
                </MotionReveal>
              )
            })}
          </div>
        )}
      </GatewayPanelSection>

      <GatewayPanelSection
        title={t("fieldStripHeading")}
        description={t("fieldStripHelp")}
        badge={t("liveBadge")}
        badgeVariant="secondary"
      >
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
            validate={(value) =>
              isValidFieldStripException(value) ? null : t("fieldStripAllowInvalid")
            }
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
 * controlled inputs whose draft state must not be disturbed. The tick stops
 * once the cooldown has lifted.
 */
function CooldownCountdown({ untilMs, onElapsed }: { untilMs: number; onElapsed: () => void }) {
  const t = useTranslations("settings.gateway")
  const [now, setNow] = useState(() => Date.now())
  const elapsed = untilMs - now <= 0

  useEffect(() => {
    if (elapsed) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [elapsed])

  useEffect(() => {
    if (elapsed) onElapsed()
  }, [elapsed, onElapsed])

  if (elapsed) {
    return (
      <Badge variant="outline" className="shrink-0" data-testid="gateway-cooldown-recovered">
        {t("cooldownsRecovered")}
      </Badge>
    )
  }

  const remaining = Math.ceil((untilMs - now) / 1000)
  return (
    <Badge
      variant="secondary"
      className="shrink-0 tabular-nums"
      data-testid="gateway-cooldown-remaining"
    >
      {remaining < 60
        ? t("cooldownsRecoversIn", { seconds: remaining })
        : t("cooldownsRecoversInMinutes", {
            minutes: Math.floor(remaining / 60),
            seconds: remaining % 60,
          })}
    </Badge>
  )
}
