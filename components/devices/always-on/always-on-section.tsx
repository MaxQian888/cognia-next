"use client"

/**
 * Always-on work on a paired host (ADR-0224 A5): the chapter of a remote
 * host's device page that says what it runs for this device, and moves more.
 *
 *  * **Runs here for you.** Each item this device moved to the host is a
 *    placeholder here, disabled and never run. Taking one back removes the
 *    host's copy, then restores this one with the status the host had.
 *  * **Stopped short.** A move or take-back that was interrupted is resumed
 *    from the step its journal recorded, under the same operation id, so
 *    nothing is created twice. A take-back that went ahead without the host
 *    finishes here once the host can be reached.
 *  * **Move work here.** Opens the guided flow.
 *
 * Every host write needs the one admin lease `useMigrationLease` holds. When
 * the host waits for a person to approve this device, the code they need is
 * shown in place and the action continues once they have.
 *
 * Taking back an item from a host that cannot be reached is possible, but it
 * says what it means first: the host keeps running its copy until it can be
 * told to stop, so for a while the item may run in both places.
 */

import { ArrowRightLeftIcon, RotateCcwIcon, ServerIcon, ShieldAlertIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useState } from "react"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
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
import { useAlwaysOnWork } from "@/hooks/remote-host/use-always-on-work"
import { useMigrationLease } from "@/hooks/remote-host/use-migration-lease"
import type { ItemMigrationRow } from "@/lib/db/item-migrations"
import type { DeviceRow } from "@/lib/devices/types"
import type { AlwaysOnItem, AlwaysOnWork } from "@/lib/remote-host/migration/candidates"
import {
  finishPendingTakeBack,
  resumeMove,
  takeBackItem,
} from "@/lib/remote-host/migration/service"
import type { MigrationOutcome } from "@/lib/remote-host/migration/types"
import type { HostAdminLease } from "@/lib/tauri/admin-lease"

import { DeviceSection } from "../device-section"
import { MoveWorkDialog, type MoveWorkDialogDeps } from "./move-work-dialog"
import { useMigrationText } from "./migration-text"

export interface AlwaysOnSectionDeps {
  load?: (hostId: string) => Promise<AlwaysOnWork>
  requestLease?: (hostId: string) => Promise<HostAdminLease>
  takeBack?: typeof takeBackItem
  resume?: typeof resumeMove
  finish?: typeof finishPendingTakeBack
  dialog?: MoveWorkDialogDeps
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function AlwaysOnSection({
  row,
  deps = {},
}: {
  row: DeviceRow
  deps?: AlwaysOnSectionDeps
}) {
  const t = useTranslations("devices.alwaysOn")
  const text = useMigrationText()
  const hostId = row.hostId ?? null
  const host = row.label
  const { work, error, reload } = useAlwaysOnWork(hostId, deps.load ? { load: deps.load } : {})
  const lease = useMigrationLease(hostId, deps.requestLease ? { request: deps.requestLease } : {})
  const takeBack = deps.takeBack ?? takeBackItem
  const resume = deps.resume ?? resumeMove
  const finish = deps.finish ?? finishPendingTakeBack

  const [moveOpen, setMoveOpen] = useState(false)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  /** The action waiting on a person at the host. */
  const [awaiting, setAwaiting] = useState<{ key: string; run: () => Promise<void> } | null>(null)
  /** A take-back the host could not be asked about, waiting on the user's word. */
  const [unreachable, setUnreachable] = useState<{ item: AlwaysOnItem; error: string } | null>(null)

  const report = (label: string, outcome: MigrationOutcome) => {
    if (outcome.ok && outcome.state === "awaiting-host") {
      toast.success(t("takeBack.awaitingHost", { label, host }))
    } else if (outcome.ok) {
      toast.success(t("done", { label }))
    } else {
      toast.error(t("failed", { label, error: outcome.error ?? outcome.state }))
    }
  }

  /**
   * Run `act` with the lease. `onNoHost` is called instead when the host could
   * not be asked for one at all.
   */
  const withLease = async (
    key: string,
    act: (adminLease: string) => Promise<void>,
    onNoHost?: (error: string) => void
  ): Promise<void> => {
    setBusyKey(key)
    try {
      let token: string | null
      try {
        token = await lease.acquire()
      } catch (cause) {
        if (onNoHost) onNoHost(message(cause))
        else toast.error(message(cause))
        return
      }
      if (!token) {
        setAwaiting({ key, run: () => withLease(key, act, onNoHost) })
        return
      }
      setAwaiting(null)
      await act(token)
    } catch (cause) {
      toast.error(message(cause))
    } finally {
      setBusyKey(null)
      await reload()
    }
  }

  const takeBackNow = (item: AlwaysOnItem) =>
    withLease(
      `${item.ref.kind}:${item.ref.id}`,
      async (adminLease) => report(item.label, await takeBack(item.ref, { adminLease })),
      (error) => setUnreachable({ item, error })
    )

  const takeBackWithoutHost = async (item: AlwaysOnItem) => {
    setUnreachable(null)
    setBusyKey(`${item.ref.kind}:${item.ref.id}`)
    try {
      report(item.label, await takeBack(item.ref, { evenIfHostUnreachable: true }))
    } catch (cause) {
      toast.error(message(cause))
    } finally {
      setBusyKey(null)
      await reload()
    }
  }

  const continueOperation = (operation: ItemMigrationRow) => {
    const item: AlwaysOnItem = {
      ref: { kind: operation.itemKind, id: operation.itemId },
      label: operation.itemLabel,
    }
    if (operation.direction === "move") {
      return withLease(operation.operationId, async (adminLease) =>
        report(operation.itemLabel, await resume(operation.operationId, { adminLease }))
      )
    }
    if (operation.state === "awaiting-host") {
      return withLease(operation.operationId, async (adminLease) =>
        report(operation.itemLabel, await finish(operation.operationId, { adminLease }))
      )
    }
    return takeBackNow(item)
  }

  if (!hostId) return null

  return (
    <DeviceSection
      id="always-on"
      title={t("title")}
      icon={ServerIcon}
      meta={work ? t("meta", { count: work.movedHere.length }) : undefined}
      description={t("description", { host })}
      wide
    >
      <div className="space-y-4" data-testid="always-on-section">
        {error ? (
          <Alert variant="destructive">
            <AlertDescription className="break-words">{error}</AlertDescription>
          </Alert>
        ) : null}

        {awaiting ? (
          <Alert data-testid="always-on-consent">
            <ShieldAlertIcon className="size-4" />
            <AlertTitle>{t("consent.title", { host })}</AlertTitle>
            <AlertDescription className="space-y-2">
              <p>
                {lease.awaitingConsent?.code
                  ? t("consent.body", { host })
                  : t("consent.bodyNoCode", { host })}
              </p>
              {lease.awaitingConsent?.code ? (
                <code className="block w-fit rounded bg-muted px-2 py-1 font-mono text-base tracking-widest">
                  {lease.awaitingConsent.code}
                </code>
              ) : null}
              <Button
                size="sm"
                disabled={lease.requesting}
                onClick={() => void awaiting.run()}
                data-testid="always-on-consent-continue"
              >
                {t("consent.continue")}
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}

        {work && work.unfinished.length > 0 ? (
          <div data-testid="always-on-unfinished">
            <h3 className="mb-1.5 text-xs font-medium text-muted-foreground uppercase">
              {t("unfinishedTitle")}
            </h3>
            <ul className="space-y-1.5">
              {work.unfinished.map((operation) => (
                <li
                  key={operation.operationId}
                  className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 px-2.5 py-2 text-sm"
                >
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{operation.itemLabel}</span>{" "}
                    <span className="text-muted-foreground">
                      {t(`direction.${operation.direction}`)} · {text.state(operation.state)}
                    </span>
                    {operation.error ? (
                      <span className="block text-xs break-words text-destructive">
                        {operation.error}
                      </span>
                    ) : null}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busyKey !== null}
                    onClick={() => void continueOperation(operation)}
                    data-testid={`always-on-continue-${operation.operationId}`}
                  >
                    <RotateCcwIcon className="size-3.5" />
                    {operation.direction === "move"
                      ? t("resume")
                      : operation.state === "awaiting-host"
                        ? t("finish")
                        : t("retry")}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div>
          <h3 className="mb-1.5 text-xs font-medium text-muted-foreground uppercase">
            {t("movedHereTitle", { host })}
          </h3>
          {work && work.movedHere.length > 0 ? (
            <ul className="space-y-1.5" data-testid="always-on-moved">
              {work.movedHere.map((item) => {
                const key = `${item.ref.kind}:${item.ref.id}`
                return (
                  <li
                    key={key}
                    className="flex flex-wrap items-center gap-2 rounded-md border px-2.5 py-2 text-sm"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="font-medium">{item.label}</span>{" "}
                      <Badge variant="outline" className="ml-1 text-[10px]">
                        {text.kind(item.ref.kind)}
                      </Badge>
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busyKey !== null}
                      onClick={() => void takeBackNow(item)}
                      data-testid={`always-on-take-back-${item.ref.id}`}
                    >
                      {busyKey === key ? t("takingBack") : t("takeBack.action")}
                    </Button>
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              {work ? t("movedHereEmpty", { host }) : t("loading")}
            </p>
          )}
        </div>

        <Button
          variant="secondary"
          disabled={!work || work.local.length === 0}
          onClick={() => setMoveOpen(true)}
          data-testid="always-on-move"
        >
          <ArrowRightLeftIcon className="size-3.5" />
          {t("moveAction", { host })}
        </Button>
      </div>

      {work ? (
        <MoveWorkDialog
          open={moveOpen}
          onOpenChange={setMoveOpen}
          hostId={hostId}
          hostLabel={host}
          items={work.local}
          lease={lease}
          onChanged={() => void reload()}
          {...(deps.dialog ? { deps: deps.dialog } : {})}
        />
      ) : null}

      <AlertDialog
        open={unreachable !== null}
        onOpenChange={(open) => !open && setUnreachable(null)}
      >
        <AlertDialogContent data-testid="always-on-unreachable">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("takeBack.unreachableTitle", { host })}</AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              <span className="block break-words">{unreachable?.error}</span>
              <span className="block">
                {t("takeBack.unreachableBody", { host, label: unreachable?.item.label ?? "" })}
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("takeBack.keepOnHost")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => unreachable && void takeBackWithoutHost(unreachable.item)}
              data-testid="always-on-take-back-anyway"
            >
              {t("takeBack.anyway")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DeviceSection>
  )
}
