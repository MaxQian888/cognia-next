"use client"

/**
 * The guided flow for moving always-on work to a paired host (ADR-0224 §Moving
 * an item is a handoff).
 *
 * It opens by asking the host about everything this device runs, so the user
 * starts from the answer rather than a checklist: what can move now, what can
 * move once the host has some plugins, and what stays here and why. Every
 * blocker is listed in the words `useMigrationText` gives it. Nothing is sent
 * until the user picks the items and presses Move; the host may then ask a
 * person to approve this device first, and the code they need is shown here.
 *
 * Plugin transfer is offered where it clears every blocker an item has. After
 * it the host is asked again, because only the host can say whether the
 * plugins it installed are enough.
 */

import { ArrowRightLeftIcon, CheckIcon, PackageIcon, ShieldAlertIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useCallback, useEffect, useMemo, useState } from "react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"
import type { UseMigrationLeaseResult } from "@/hooks/remote-host/use-migration-lease"
import type { TransferInstallResult } from "@/lib/plugin/cogpack/transfer-install"
import type { AlwaysOnItem } from "@/lib/remote-host/migration/candidates"
import {
  pluginsToTransfer,
  transferPlugins,
  type PluginTransferProgress,
} from "@/lib/remote-host/migration/plugin-transfer"
import { moveItems, preflightMigration } from "@/lib/remote-host/migration/service"
import {
  isResolvableByPluginTransfer,
  type MigrationItemRef,
  type MigrationOutcome,
  type MigrationPreflight,
} from "@/lib/remote-host/migration/types"
import { isTauri } from "@/lib/tauri"

import { useMigrationText } from "./migration-text"

export interface MoveWorkDialogDeps {
  preflight?: typeof preflightMigration
  move?: typeof moveItems
  transfer?: typeof transferPlugins
  /** Plugin trees are read from this machine's disk, which only the desktop can do. */
  canTransferPlugins?: boolean
}

export interface MoveWorkDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  hostId: string
  hostLabel: string
  /** What runs on this device, from `useAlwaysOnWork`. */
  items: readonly AlwaysOnItem[]
  lease: UseMigrationLeaseResult
  /** Something moved: the page reads its tables again. */
  onChanged: () => void
  /**
   * Move what is ready as soon as the host has answered, without waiting for
   * the Move button: the item was just created with the host as its chosen
   * place (`usePlaceNewItem`). What is not ready stays here and says why.
   */
  autoMove?: boolean
  deps?: MoveWorkDialogDeps
}

type Phase =
  | { kind: "checking" }
  | { kind: "review" }
  | { kind: "transferring"; progress: PluginTransferProgress | null }
  | { kind: "moving"; done: number; total: number }
  | { kind: "done"; outcomes: MigrationOutcome[] }
  | { kind: "failed"; error: string }

type PendingAction = "transfer" | "move"

const keyOf = (ref: MigrationItemRef) => `${ref.kind}:${ref.id}`

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function MoveWorkDialog({
  open,
  onOpenChange,
  hostId,
  hostLabel,
  items,
  lease,
  onChanged,
  autoMove = false,
  deps = {},
}: MoveWorkDialogProps) {
  const t = useTranslations("devices.alwaysOn")
  const text = useMigrationText()
  const preflight = deps.preflight ?? preflightMigration
  const move = deps.move ?? moveItems
  const transfer = deps.transfer ?? transferPlugins
  const canTransferPlugins = deps.canTransferPlugins ?? isTauri()

  const [phase, setPhase] = useState<Phase>({ kind: "checking" })
  const [preflights, setPreflights] = useState<MigrationPreflight[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [pending, setPending] = useState<PendingAction | null>(null)
  const [pluginResult, setPluginResult] = useState<TransferInstallResult | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  // Each opening starts over, reset while rendering it rather than in an
  // effect, so the first frame of a reopened dialog is already "checking".
  const [openSeen, setOpenSeen] = useState(false)
  if (open !== openSeen) {
    setOpenSeen(open)
    if (open) {
      setPhase({ kind: "checking" })
      setPending(null)
      setPluginResult(null)
      setActionError(null)
    }
  }

  /**
   * Ask the host about the batch; the caller has already shown "checking".
   * Ready items start selected; asked again (after a plugin transfer), an
   * item that was ready before keeps the choice the user made, and one that
   * has just become ready is selected. Resolves to the answer, or null when
   * the host could not be asked.
   */
  const check = useCallback(
    async (previous?: {
      selected: ReadonlySet<string>
      ready: ReadonlySet<string>
    }): Promise<MigrationPreflight[] | null> => {
      try {
        const answer = await preflight(
          hostId,
          items.map((item) => item.ref)
        )
        setPreflights(answer)
        setSelected(
          new Set(
            answer
              .filter((p) => p.ready)
              .map((p) => keyOf(p.item))
              .filter((key) => !previous || previous.selected.has(key) || !previous.ready.has(key))
          )
        )
        setPhase({ kind: "review" })
        return answer
      } catch (error) {
        setPhase({ kind: "failed", error: message(error) })
        return null
      }
    },
    [hostId, items, preflight]
  )

  const groups = useMemo(() => {
    const ready = preflights.filter((p) => p.ready)
    const needsPlugins = preflights.filter(
      (p) => !p.ready && p.blockers.every(isResolvableByPluginTransfer)
    )
    const staysHere = preflights.filter(
      (p) => !p.ready && !p.blockers.every(isResolvableByPluginTransfer)
    )
    return { ready, needsPlugins, staysHere }
  }, [preflights])

  const plugins = useMemo(() => pluginsToTransfer(groups.needsPlugins), [groups.needsPlugins])

  const withLease = async (action: PendingAction, run: (adminLease: string) => Promise<void>) => {
    setActionError(null)
    let token: string | null
    try {
      token = await lease.acquire()
    } catch (error) {
      setActionError(message(error))
      return
    }
    if (!token) {
      setPending(action)
      return
    }
    setPending(null)
    await run(token)
  }

  const sendPlugins = () =>
    withLease("transfer", async (adminLease) => {
      setPhase({ kind: "transferring", progress: null })
      try {
        const result = await transfer(hostId, plugins, {
          adminLease,
          onProgress: (progress) => setPhase({ kind: "transferring", progress }),
        })
        setPluginResult(result)
      } catch (error) {
        setActionError(message(error))
      }
      // Only the host can say whether what it installed is enough.
      setPhase({ kind: "checking" })
      await check({
        selected,
        ready: new Set(groups.ready.map((p) => keyOf(p.item))),
      })
    })

  const moveRefs = (refs: MigrationItemRef[]) =>
    withLease("move", async (adminLease) => {
      setPhase({ kind: "moving", done: 0, total: refs.length })
      try {
        let done = 0
        const outcomes = await move(hostId, refs, {
          adminLease,
          onProgress: () => {
            done += 1
            setPhase({ kind: "moving", done, total: refs.length })
          },
        })
        setPhase({ kind: "done", outcomes })
      } catch (error) {
        setPhase({ kind: "failed", error: message(error) })
      } finally {
        onChanged()
      }
    })

  useEffect(() => {
    if (!open) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- asks the host; every result lands after the await
    void check().then((answer) => {
      // A new item placed on the host moves as soon as the host says it can.
      if (!autoMove || !answer) return
      const ready = answer.filter((p) => p.ready).map((p) => p.item)
      if (ready.length > 0) void moveRefs(ready)
    })
    // Asked once per opening; the list it was opened with is the batch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const moveSelected = () =>
    moveRefs(preflights.filter((p) => selected.has(keyOf(p.item))).map((p) => p.item))

  const toggle = (key: string, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current)
      if (on) next.add(key)
      else next.delete(key)
      return next
    })

  const busy = phase.kind === "checking" || phase.kind === "transferring" || phase.kind === "moving"

  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <DialogContent
        className="max-h-[85vh] overflow-y-auto sm:max-w-xl"
        data-testid="move-work-dialog"
      >
        <DialogHeader>
          <DialogTitle>{t("move.title", { host: hostLabel })}</DialogTitle>
          <DialogDescription>{t("move.description", { host: hostLabel })}</DialogDescription>
        </DialogHeader>

        {phase.kind === "checking" ? (
          <p
            className="flex items-center gap-2 text-sm text-muted-foreground"
            data-testid="move-checking"
          >
            <Spinner className="size-4" />
            {t("move.checking", { host: hostLabel })}
          </p>
        ) : null}

        {phase.kind === "failed" ? (
          <Alert variant="destructive" data-testid="move-failed">
            <AlertTitle>{t("move.failedTitle")}</AlertTitle>
            <AlertDescription className="break-words">{phase.error}</AlertDescription>
          </Alert>
        ) : null}

        {pending ? (
          <Alert data-testid="move-consent">
            <ShieldAlertIcon className="size-4" />
            <AlertTitle>{t("consent.title", { host: hostLabel })}</AlertTitle>
            <AlertDescription className="space-y-2">
              <p>
                {lease.awaitingConsent?.code
                  ? t("consent.body", { host: hostLabel })
                  : t("consent.bodyNoCode", { host: hostLabel })}
              </p>
              {lease.awaitingConsent?.code ? (
                <code className="block w-fit rounded bg-muted px-2 py-1 font-mono text-base tracking-widest">
                  {lease.awaitingConsent.code}
                </code>
              ) : null}
              <Button
                size="sm"
                disabled={lease.requesting}
                onClick={() => void (pending === "transfer" ? sendPlugins() : moveSelected())}
                data-testid="move-consent-continue"
              >
                {t("consent.continue")}
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}

        {actionError ? (
          <Alert variant="destructive" data-testid="move-action-error">
            <AlertDescription className="break-words">{actionError}</AlertDescription>
          </Alert>
        ) : null}

        {phase.kind === "review" ? (
          <div className="space-y-4">
            {preflights.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("move.nothingHere")}</p>
            ) : null}

            {groups.ready.length > 0 ? (
              <section data-testid="move-ready">
                <h3 className="mb-1.5 text-xs font-medium text-muted-foreground uppercase">
                  {t("move.readyTitle", { count: groups.ready.length })}
                </h3>
                <ul className="space-y-1.5">
                  {groups.ready.map((p) => (
                    <li key={keyOf(p.item)} className="rounded-md border px-2.5 py-2">
                      <label className="flex items-start gap-2 text-sm">
                        <Checkbox
                          checked={selected.has(keyOf(p.item))}
                          onCheckedChange={(on) => toggle(keyOf(p.item), on === true)}
                          aria-label={p.label}
                          data-testid={`move-select-${p.item.id}`}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="font-medium">{p.label}</span>{" "}
                          <Badge variant="outline" className="ml-1 text-[10px]">
                            {text.kind(p.item.kind)}
                          </Badge>
                          {p.notes.map((note, index) => (
                            <span key={index} className="mt-1 block text-xs text-muted-foreground">
                              {text.note(note, hostLabel)}
                            </span>
                          ))}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {groups.needsPlugins.length > 0 ? (
              <section data-testid="move-needs-plugins">
                <h3 className="mb-1.5 text-xs font-medium text-muted-foreground uppercase">
                  {t("move.needsPluginsTitle", { count: groups.needsPlugins.length })}
                </h3>
                <ItemBlockers preflights={groups.needsPlugins} host={hostLabel} />
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!canTransferPlugins || plugins.length === 0}
                    onClick={() => void sendPlugins()}
                    data-testid="move-send-plugins"
                  >
                    <PackageIcon className="size-3.5" />
                    {t("move.sendPlugins", { count: plugins.length, host: hostLabel })}
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    {canTransferPlugins
                      ? t("move.sendPluginsHint", { host: hostLabel })
                      : t("move.sendPluginsDesktopOnly")}
                  </span>
                </div>
              </section>
            ) : null}

            {pluginResult ? (
              <Alert data-testid="move-plugin-result">
                <PackageIcon className="size-4" />
                <AlertDescription>
                  {t("move.pluginsInstalled", {
                    count: pluginResult.installed.length,
                    host: hostLabel,
                  })}
                  {pluginResult.failed.map((failure) => (
                    <span key={failure.pluginId} className="mt-1 block text-destructive">
                      {t("move.pluginFailed", {
                        pluginId: failure.pluginId,
                        error: failure.message,
                      })}
                    </span>
                  ))}
                </AlertDescription>
              </Alert>
            ) : null}

            {groups.staysHere.length > 0 ? (
              <section data-testid="move-stays-here">
                <h3 className="mb-1.5 text-xs font-medium text-muted-foreground uppercase">
                  {t("move.staysHereTitle", { count: groups.staysHere.length })}
                </h3>
                <ItemBlockers preflights={groups.staysHere} host={hostLabel} />
              </section>
            ) : null}
          </div>
        ) : null}

        {phase.kind === "transferring" ? (
          <div className="space-y-2" data-testid="move-transferring">
            <p className="text-sm">
              {t(`move.transfer.${phase.progress?.phase ?? "packing"}`, { host: hostLabel })}
            </p>
            {phase.progress && phase.progress.totalBytes > 0 ? (
              <Progress value={(phase.progress.sentBytes / phase.progress.totalBytes) * 100} />
            ) : null}
          </div>
        ) : null}

        {phase.kind === "moving" ? (
          <div className="space-y-2" data-testid="move-moving">
            <p className="text-sm">
              {t("move.moving", { done: phase.done, total: phase.total, host: hostLabel })}
            </p>
            <Progress value={phase.total > 0 ? (phase.done / phase.total) * 100 : 0} />
          </div>
        ) : null}

        {phase.kind === "done" ? (
          <ul className="space-y-1.5" data-testid="move-done">
            {phase.outcomes.map((outcome) => {
              const label =
                preflights.find((p) => keyOf(p.item) === keyOf(outcome.item))?.label ??
                outcome.item.id
              return (
                <li key={keyOf(outcome.item)} className="flex items-start gap-2 text-sm">
                  {outcome.ok ? (
                    <CheckIcon className="mt-0.5 size-4 text-emerald-600" aria-hidden="true" />
                  ) : (
                    <ShieldAlertIcon
                      className="mt-0.5 size-4 text-destructive"
                      aria-hidden="true"
                    />
                  )}
                  <span className="min-w-0">
                    <span className="font-medium">{label}</span>{" "}
                    <span className="text-muted-foreground">
                      {outcome.ok
                        ? t("move.outcomeMoved", { host: hostLabel })
                        : t("move.outcomeFailed", { error: outcome.error ?? outcome.state })}
                    </span>
                  </span>
                </li>
              )
            })}
          </ul>
        ) : null}

        <DialogFooter>
          {phase.kind === "done" ? (
            <Button onClick={() => onOpenChange(false)} data-testid="move-close">
              {t("move.close")}
            </Button>
          ) : (
            <>
              <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
                {t("move.cancel")}
              </Button>
              <Button
                disabled={phase.kind !== "review" || selected.size === 0 || lease.requesting}
                onClick={() => void moveSelected()}
                data-testid="move-confirm"
              >
                <ArrowRightLeftIcon className="size-3.5" />
                {t("move.confirm", { count: selected.size, host: hostLabel })}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Each item with every blocker it has, in the order the preflight listed them. */
function ItemBlockers({
  preflights,
  host,
}: {
  preflights: readonly MigrationPreflight[]
  host: string
}) {
  const text = useMigrationText()
  return (
    <ul className="space-y-1.5">
      {preflights.map((p) => (
        <li key={keyOf(p.item)} className="rounded-md border border-dashed px-2.5 py-2 text-sm">
          <span className="font-medium">{p.label}</span>{" "}
          <Badge variant="outline" className="ml-1 text-[10px]">
            {text.kind(p.item.kind)}
          </Badge>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
            {p.blockers.map((blocker, index) => (
              <li key={index}>{text.blocker(blocker, host)}</li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  )
}
