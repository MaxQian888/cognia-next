"use client"

/**
 * Host runtimes (ADR-0059 W2): the chapter of an always-on host's device page
 * that lists the brain's headless runtimes (connectors, sync sources,
 * schedulers, plugins…) and restarts one without restarting the host.
 *
 *  * **A runtime that failed to start** leads the list, with the reason the
 *    host gave, and restarts directly.
 *  * **A running runtime** restarts after a confirmation, since stopping it
 *    interrupts what it is doing.
 *  * **A runtime that cannot be restarted** says so: it is running and has no
 *    teardown, so only restarting the host restarts it.
 *  * **A host that cannot report runtimes** says why: a desktop app runs them
 *    in its window, and a host from before runtime control needs updating.
 */

import { useState } from "react"
import { BoxesIcon, RefreshCwIcon, RotateCwIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useHostRuntimes, type UseHostRuntimesDeps } from "@/hooks/remote-host/use-host-runtimes"
import { managementRefOf } from "@/lib/devices/section-plan"
import type { DeviceRow } from "@/lib/devices/types"
import { failedHostRuntimes, type HostRuntime } from "@/lib/remote-host/host-runtimes"
import { cn } from "@/lib/utils"

import { DeviceSection } from "../device-section"
import { useDeviceRelativeTime } from "../device-visuals"

const STATE_ORDER: Record<HostRuntime["state"], number> = { failed: 0, restarting: 1, running: 2 }

/** Failed first, then restarting, then running; the host's order within each. */
export function orderRuntimes(runtimes: readonly HostRuntime[]): HostRuntime[] {
  return runtimes
    .map((runtime, index) => ({ runtime, index }))
    .sort(
      (a, b) => STATE_ORDER[a.runtime.state] - STATE_ORDER[b.runtime.state] || a.index - b.index
    )
    .map(({ runtime }) => runtime)
}

export function HostRuntimesSection({ row, deps }: { row: DeviceRow; deps?: UseHostRuntimesDeps }) {
  const t = useTranslations("devices.hostRuntimes")
  const relative = useDeviceRelativeTime()
  const { runtimes, unavailable, error, loading, restarting, reload, restart } = useHostRuntimes(
    managementRefOf(row),
    deps
  )
  const [confirming, setConfirming] = useState<HostRuntime | null>(null)

  const restartNow = async (runtime: HostRuntime) => {
    setConfirming(null)
    const outcome = await restart(runtime.name)
    if (outcome.error) {
      toast.error(t("restartFailed", { name: runtime.name, error: outcome.error }))
    } else if (outcome.runtime?.state === "running") {
      toast.success(t("restarted", { name: runtime.name }))
    } else {
      toast.error(
        t("restartDidNotStart", {
          name: runtime.name,
          error: outcome.runtime?.error ?? t("noReason"),
        })
      )
    }
  }

  const refresh = (
    <Button
      size="sm"
      variant="ghost"
      className="size-6 p-0"
      aria-label={t("refresh")}
      disabled={loading || unavailable !== null}
      onClick={() => void reload()}
      data-testid="host-runtimes-refresh"
    >
      <RefreshCwIcon className={cn("size-3.5", loading && "animate-spin")} />
    </Button>
  )

  const failedCount = runtimes ? failedHostRuntimes(runtimes).length : 0

  return (
    <DeviceSection id="host-runtimes" title={t("title")} icon={BoxesIcon} meta={refresh} wide>
      <div className="space-y-3 text-sm" data-testid="host-runtimes">
        {unavailable ? (
          <Alert data-testid="host-runtimes-unavailable" data-reason={unavailable}>
            <AlertDescription>{t(`unavailable.${unavailable}`)}</AlertDescription>
          </Alert>
        ) : !runtimes ? (
          <p className="text-muted-foreground" data-testid="host-runtimes-status">
            {error ? t("unreachable", { error }) : t("loading")}
          </p>
        ) : (
          <>
            <p
              className={cn(failedCount > 0 ? "text-destructive" : "text-muted-foreground")}
              data-testid="host-runtimes-summary"
            >
              {runtimes.length === 0
                ? t("summary.none")
                : failedCount > 0
                  ? t("summary.failed", { failed: failedCount, total: runtimes.length })
                  : t("summary.allRunning", { total: runtimes.length })}
            </p>
            {error ? (
              <p className="text-xs text-muted-foreground">{t("staleList", { error })}</p>
            ) : null}
            <ul className="divide-y rounded-md border" data-testid="host-runtimes-list">
              {orderRuntimes(runtimes).map((runtime) => {
                const busy = restarting === runtime.name || runtime.state === "restarting"
                return (
                  <li
                    key={runtime.name}
                    className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-3 py-2"
                    data-testid={`host-runtime-${runtime.name}`}
                    data-state={runtime.state}
                  >
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs">{runtime.name}</span>
                        <Badge
                          variant={runtime.state === "failed" ? "destructive" : "secondary"}
                          className="text-[10px]"
                        >
                          {t(`state.${runtime.state}`)}
                        </Badge>
                      </div>
                      {runtime.error ? (
                        <p className="text-xs break-words text-destructive">{runtime.error}</p>
                      ) : null}
                      <p className="text-xs text-muted-foreground">
                        {[
                          runtime.startedAt !== undefined
                            ? t("startedAt", { when: relative(runtime.startedAt) })
                            : null,
                          runtime.restarts > 0 ? t("restarts", { count: runtime.restarts }) : null,
                          !runtime.restartable && runtime.state === "running"
                            ? t("notRestartable")
                            : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant={runtime.state === "failed" ? "default" : "outline"}
                      disabled={!runtime.restartable || busy || restarting !== null}
                      onClick={() =>
                        runtime.state === "failed"
                          ? void restartNow(runtime)
                          : setConfirming(runtime)
                      }
                      data-testid={`host-runtime-restart-${runtime.name}`}
                    >
                      <RotateCwIcon
                        aria-hidden
                        className={cn("size-3.5", busy && "animate-spin")}
                      />
                      {busy ? t("restarting") : t("restart")}
                    </Button>
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </div>

      <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("confirm.title", { name: confirming?.name ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t("confirm.body")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("confirm.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => confirming && void restartNow(confirming)}
              data-testid="host-runtime-restart-confirm"
            >
              {t("confirm.restart")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DeviceSection>
  )
}
