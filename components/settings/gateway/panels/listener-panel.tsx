"use client"

/**
 * Settings → Gateway → Listener — the bind-time configuration.
 *
 * `GatewayState` splits its config in two: request-time fields (timeouts, retry
 * policy, model exposure, per-key limits) are read live on every request, while
 * bind-time fields — port, interface, allowlist — are snapshotted when the
 * listener starts and do nothing until it is restarted. That distinction was
 * previously carried by one generic sentence at the bottom of a long card, so
 * changing the port on a running gateway looked like it had taken effect.
 *
 * Everything here is bind-time, and the panel says so per-field AND offers the
 * restart rather than leaving the user to toggle the switch twice.
 */

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import { AlertTriangleIcon, Loader2Icon, RotateCwIcon } from "lucide-react"
import { toast } from "sonner"

import { MotionCollapse } from "@/components/chat/motion/motion-reveal"
import { SettingsCard } from "@/components/settings/common/settings-section"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { gatewayStart, gatewayStop } from "@/lib/tauri/gateway"
import { type GatewayBindInterface } from "@/types/gateway"

import { ChipInput } from "../shared/chip-input"
import { NumberRow } from "../../common/number-row"
import type { GatewayPanelContext } from "../gateway-section"

export interface GatewayListenerPanelProps {
  ctx: GatewayPanelContext
  onRestarted: () => Promise<void>
}

export function GatewayListenerPanel({ ctx, onRestarted }: GatewayListenerPanelProps) {
  const t = useTranslations("settings.gateway")
  const { config, status, persist } = ctx
  const [restarting, setRestarting] = useState(false)
  // The allowlist has no mirror on `GatewayStatus`, so a divergence from the
  // running listener cannot be derived the way port/interface can. Tracked from
  // the edit instead — deliberately conservative: it clears only on restart.
  const [allowlistDirty, setAllowlistDirty] = useState(false)

  const running = status?.running ?? false
  const portDiverged = running && status?.boundPort != null && status.boundPort !== config.port
  const interfaceDiverged = running && status?.bindInterface !== config.bindInterface
  const needsRestart = Boolean(portDiverged || interfaceDiverged || (running && allowlistDirty))

  const onRestart = useCallback(async () => {
    setRestarting(true)
    try {
      await gatewayStop()
      await gatewayStart()
      setAllowlistDirty(false)
      await onRestarted()
      toast.success(t("restarted"))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setRestarting(false)
    }
  }, [onRestarted, t])

  return (
    <div className="space-y-4">
      <SettingsCard
        title={t("listenerHeading")}
        description={t("listenerHelp")}
        badge={t("bindTimeBadge")}
        badgeVariant="outline"
        headerAction={
          <MotionCollapse open={needsRestart}>
            <Button
              size="sm"
              variant="default"
              disabled={restarting}
              onClick={() => void onRestart()}
              data-testid="gateway-restart-listener"
            >
              {restarting ? (
                <Loader2Icon className="mr-1.5 size-3.5 animate-spin" aria-hidden />
              ) : (
                <RotateCwIcon className="mr-1.5 size-3.5" aria-hidden />
              )}
              {t("restartListener")}
            </Button>
          </MotionCollapse>
        }
      >
        <MotionCollapse open={needsRestart}>
          <div
            className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-xs text-amber-700 dark:text-amber-400"
            data-testid="gateway-restart-required"
          >
            <AlertTriangleIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{t("restartRequired")}</span>
          </div>
        </MotionCollapse>

        <NumberRow
          id="gw-port"
          label={t("port")}
          help={t("portHelp")}
          value={config.port}
          min={1024}
          max={65535}
          onCommit={(v) => void persist({ port: v })}
        />

        <div className="space-y-2">
          <Label>{t("bindInterface")}</Label>
          <div className="flex gap-1" role="group" aria-label={t("bindInterface")}>
            {(["loopback", "lan"] as const).map((iface) => (
              <Button
                key={iface}
                size="sm"
                variant={config.bindInterface === iface ? "default" : "outline"}
                onClick={() => void persist({ bindInterface: iface as GatewayBindInterface })}
              >
                {t(iface === "loopback" ? "bindLoopback" : "bindLan")}
              </Button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{t("bindHelp")}</p>
          <MotionCollapse open={config.bindInterface === "lan"}>
            <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-xs text-amber-700 dark:text-amber-400">
              <AlertTriangleIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{t("lanWarning")}</span>
            </div>
          </MotionCollapse>
        </div>

        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Label>{t("allowlist")}</Label>
            <Badge variant="outline" className="text-[10px]">
              {t("bindTimeBadge")}
            </Badge>
          </div>
          <ChipInput
            values={config.allowlist}
            onCommit={(next) => {
              setAllowlistDirty(true)
              void persist({ allowlist: next })
            }}
            placeholder={t("allowlistPlaceholder")}
            ariaLabel={t("allowlist")}
            addLabel={t("add")}
            removeLabel={t("remove")}
          />
          <p className="text-xs text-muted-foreground">{t("allowlistHelp")}</p>
        </div>
      </SettingsCard>
    </div>
  )
}
