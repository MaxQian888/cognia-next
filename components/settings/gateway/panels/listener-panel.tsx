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
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { gatewayStart, gatewayStop } from "@/lib/tauri/gateway"
import { type GatewayBindInterface } from "@/types/gateway"

import { ChipInput } from "../shared/chip-input"
import { NumberRow } from "../../common/number-row"
import type { GatewayPanelContext } from "../gateway-section"
import { GatewayPanelSection } from "../shared/panel-section"

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
    <GatewayPanelSection
      title={t("listenerHeading")}
      description={t("listenerHelp")}
      badge={t("bindTimeBadge")}
      badgeVariant="outline"
      action={
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
        <Alert data-testid="gateway-restart-required">
          <AlertTriangleIcon />
          <AlertDescription>{t("restartRequired")}</AlertDescription>
        </Alert>
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
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={config.bindInterface}
          onValueChange={(value) => {
            if (value) void persist({ bindInterface: value as GatewayBindInterface })
          }}
          aria-label={t("bindInterface")}
        >
          {(["loopback", "lan"] as const).map((iface) => (
            <ToggleGroupItem
              key={iface}
              value={iface}
              aria-label={t(iface === "loopback" ? "bindLoopback" : "bindLan")}
            >
              {t(iface === "loopback" ? "bindLoopback" : "bindLan")}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <p className="text-xs text-muted-foreground">{t("bindHelp")}</p>
        <MotionCollapse open={config.bindInterface === "lan"}>
          <Alert>
            <AlertTriangleIcon />
            <AlertDescription>{t("lanWarning")}</AlertDescription>
          </Alert>
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
    </GatewayPanelSection>
  )
}
