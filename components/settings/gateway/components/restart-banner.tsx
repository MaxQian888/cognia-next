"use client"

/**
 * "The running listener is not serving what you saved" — pinned above every
 * gateway panel while Rust reports bind-time edits.
 *
 * Bind-time fields live on two panels (Listener, Reliability) and the raw
 * editor can change any of them, but the restart action used to exist only on
 * the Listener panel, and the pending state only in that panel's memory: an
 * edit made from Custom showed a badge with nothing to press, and closing
 * Settings forgot the edit had not applied. The banner is one control for all
 * three, fed by `GatewayStatus.pendingRestartFields`.
 */

import { useFormatter, useTranslations } from "next-intl"
import { Loader2Icon, RotateCwIcon } from "lucide-react"

import { MotionCollapse } from "@/components/chat/motion/motion-reveal"
import { Button } from "@/components/ui/button"
import type { GatewayBindTimeField } from "@/types/gateway"

/**
 * Each field as a noun for the middle of a sentence. Not the form labels:
 * those are capitalised and carry units ("Connect timeout (s)"), which read
 * wrongly once listed inside "still uses the previous …".
 */
export const BIND_TIME_FIELD_NAME_KEYS: Record<GatewayBindTimeField, string> = {
  port: "bindTimeFieldNames.port",
  bindInterface: "bindTimeFieldNames.bindInterface",
  allowlist: "bindTimeFieldNames.allowlist",
  rateLimitPerMin: "bindTimeFieldNames.rateLimitPerMin",
  connectTimeoutSecs: "bindTimeFieldNames.connectTimeoutSecs",
}

export interface GatewayRestartBannerProps {
  pending: readonly GatewayBindTimeField[]
  restarting: boolean
  onRestart: () => void
}

export function GatewayRestartBanner({
  pending,
  restarting,
  onRestart,
}: GatewayRestartBannerProps) {
  const t = useTranslations("settings.gateway")
  const format = useFormatter()
  const open = pending.length > 0

  return (
    <MotionCollapse open={open}>
      {open ? (
        <div
          role="status"
          className="flex flex-col gap-2 border-b bg-warning/10 px-3 py-2.5 @md/gateway-shell:flex-row @md/gateway-shell:items-center"
          data-testid="gateway-restart-banner"
        >
          <div className="flex min-w-0 flex-1 items-start gap-2">
            <RotateCwIcon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
            <div className="min-w-0 space-y-0.5">
              <p className="text-sm font-medium">
                {t("restartBannerTitle", { count: pending.length })}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("restartBannerFields", {
                  fields: format.list(
                    pending.map((field) => t(BIND_TIME_FIELD_NAME_KEYS[field])),
                    { type: "conjunction" }
                  ),
                })}
              </p>
            </div>
          </div>
          <Button
            size="sm"
            className="self-end @md/gateway-shell:self-auto"
            disabled={restarting}
            onClick={onRestart}
            data-testid="gateway-restart-listener"
          >
            {restarting ? (
              <Loader2Icon className="mr-1.5 size-3.5 animate-spin" aria-hidden />
            ) : (
              <RotateCwIcon className="mr-1.5 size-3.5" aria-hidden />
            )}
            {t("restartListener")}
          </Button>
        </div>
      ) : null}
    </MotionCollapse>
  )
}
