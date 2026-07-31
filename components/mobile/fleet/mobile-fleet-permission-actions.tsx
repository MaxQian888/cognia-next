"use client"

/**
 * Mobile counterpart to the island's `IslandPermissionActions` — Approve/Deny a
 * parked fleet permission over the companion transport. Countdown rides the
 * shared fleet ticker; the window (`FLEET_PERMISSION_WAIT_MS`) is the same one
 * the desktop honours. A revoked control grant (403) or any send failure
 * surfaces as a toast rather than a silent no-op.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { useNowTicker } from "@/hooks/fleet/use-now-ticker"
import { fleetRemotePermissionRespond, isControlForbidden } from "@/lib/fleet/fleet-remote-actions"
import { FLEET_PERMISSION_WAIT_MS, type PendingPermission } from "@/lib/fleet/types"

export function MobileFleetPermissionActions({ pending }: { pending: PendingPermission }) {
  const t = useTranslations("mobile.fleet.permission")
  const nowMs = useNowTicker()
  const [answering, setAnswering] = useState(false)
  const [answered, setAnswered] = useState<"allow" | "deny" | null>(null)

  const remainingSec = useMemo(
    () => Math.max(0, Math.ceil((pending.requestedAt + FLEET_PERMISSION_WAIT_MS - nowMs) / 1000)),
    [pending.requestedAt, nowMs]
  )
  const expired = remainingSec <= 0

  const respond = async (behavior: "allow" | "deny") => {
    if (answering || answered || expired) return
    setAnswering(true)
    try {
      const ok = await fleetRemotePermissionRespond(pending.requestId, behavior)
      if (ok) setAnswered(behavior)
      else toast.error(t("expired"))
    } catch (err) {
      toast.error(isControlForbidden(err) ? t("controlLost") : t("failed"))
    } finally {
      setAnswering(false)
    }
  }

  return (
    <div className="space-y-1.5" data-testid="mobile-fleet-permission">
      <p className="text-xs text-amber-600 dark:text-amber-400">
        {pending.toolName ? t("request", { tool: pending.toolName }) : t("requestGeneric")}
        {pending.detail ? <span className="text-muted-foreground"> {pending.detail}</span> : null}
      </p>
      {answered ? (
        <p className="text-xs text-muted-foreground" data-testid="mobile-permission-answered">
          {t(answered === "allow" ? "allowed" : "denied")}
        </p>
      ) : expired ? (
        <p className="text-xs text-muted-foreground" data-testid="mobile-permission-expired">
          {t("expired")}
        </p>
      ) : (
        <div className="flex items-center gap-2">
          <span
            className="text-[11px] tabular-nums text-muted-foreground"
            data-testid="mobile-permission-countdown"
          >
            {t("countdown", { seconds: remainingSec })}
          </span>
          <Button
            size="sm"
            disabled={answering}
            onClick={() => void respond("allow")}
            data-testid="mobile-permission-allow"
          >
            {t("allow")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={answering}
            onClick={() => void respond("deny")}
            data-testid="mobile-permission-deny"
          >
            {t("deny")}
          </Button>
        </div>
      )}
    </div>
  )
}

export default MobileFleetPermissionActions
