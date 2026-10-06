"use client"

/**
 * Settings → Account → Sync devices → Your data (ADR-0215 phase 3a): what the
 * data engine of this window reports, and what this device syncs.
 *
 * Shown for an enrolled device. With no engine (this window shows a companion
 * mirror of another host) it says the data syncs where it lives, and for a
 * headless host, which command enrolls it there.
 */

import { useState, useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import type { EngineStatus } from "@/lib/account-sync/data/engine"
import type { SyncClasses } from "@/lib/account-sync/data/types"
import {
  getRuntimeSnapshot,
  getServerRuntimeSnapshot,
  subscribeRuntimeSnapshot,
} from "@/lib/runtime/runtime-snapshot-store"
import { useAccountSyncStore } from "@/stores/account-sync/account-sync-store"

type Running = Extract<EngineStatus, { kind: "running" }>

function Waiting({ text }: { text: string }) {
  return (
    <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
      <Spinner className="size-3" />
      {text}
    </p>
  )
}

export function AccountSyncDataPanel() {
  const t = useTranslations("accountSync.data")
  const engine = useAccountSyncStore((state) => state.engine)
  const status = useAccountSyncStore((state) => state.engineStatus)
  const openJoinDialog = useAccountSyncStore((state) => state.setJoinDialogOpen)
  const target = useSyncExternalStore(
    subscribeRuntimeSnapshot,
    () => getRuntimeSnapshot().target,
    () => getServerRuntimeSnapshot().target
  )
  // A headless host enrolls and syncs on its own, from its terminal.
  const cloudHost = target?.kind === "companion" && target.hostKind === "cloud"

  let body: React.ReactNode
  if (!engine) {
    body = (
      <div className="flex flex-col gap-1 text-xs text-muted-foreground">
        <p>{t("notHere")}</p>
        {cloudHost ? (
          <p data-testid="account-sync-headless-hint">
            {t("headlessHint", { command: "cognia-agent account-sync status" })}
          </p>
        ) : null}
      </div>
    )
  } else if (!status || status.kind === "starting" || status.kind === "stopped") {
    body = <Waiting text={t("starting")} />
  } else if (status.kind === "follower") {
    body = <p className="text-xs text-muted-foreground">{t("follower")}</p>
  } else if (status.kind === "seeding") {
    body = (
      <Waiting
        text={
          status.progress
            ? t("seedingProgress", { done: status.progress.done, total: status.progress.total })
            : t("seeding")
        }
      />
    )
  } else if (status.kind === "join-choice") {
    body = (
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{t("choicePending")}</p>
        <Button
          type="button"
          size="sm"
          onClick={() => openJoinDialog(true)}
          data-testid="account-sync-open-join"
        >
          {t("choose")}
        </Button>
      </div>
    )
  } else if (status.kind === "running") {
    body = <RunningState status={status} onSyncNow={() => engine.syncNow()} />
  } else {
    // Removed: the enrollment view above says so.
    body = null
  }

  return (
    <div className="flex flex-col gap-2" data-testid="account-sync-data">
      <h5 className="text-sm font-medium">{t("title")}</h5>
      {body}
    </div>
  )
}

function RunningState({ status, onSyncNow }: { status: Running; onSyncNow: () => void }) {
  const t = useTranslations("accountSync.data")
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5 text-xs" role="status" data-live={status.live}>
          <span>{t(`live.${status.live}`)}</span>
          {status.pending > 0 ? (
            <span className="text-muted-foreground">{t("pending", { count: status.pending })}</span>
          ) : null}
          {status.lastSyncedAt !== null ? (
            <span className="text-muted-foreground">
              {t("lastSynced", { time: new Date(status.lastSyncedAt).toLocaleTimeString() })}
            </span>
          ) : null}
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onSyncNow}
          data-testid="account-sync-sync-now"
        >
          {t("syncNow")}
        </Button>
      </div>
      {status.error ? (
        <p role="alert" className="text-xs text-destructive" data-testid="account-sync-data-error">
          {t("error", { message: status.error })}
        </p>
      ) : null}
      {status.parked.schema > 0 ? (
        <Alert data-testid="account-sync-parked-schema">
          <AlertDescription>{t("parkedSchema", { count: status.parked.schema })}</AlertDescription>
        </Alert>
      ) : null}
      {status.parked.key > 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="account-sync-parked-key">
          {t("parkedKey", { count: status.parked.key })}
        </p>
      ) : null}
      {status.tooLarge.length > 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="account-sync-too-large">
          {t("tooLarge", { count: status.tooLarge.length })}
        </p>
      ) : null}
      <SyncClassSwitches classes={status.classes} />
    </div>
  )
}

function SyncClassSwitches({ classes }: { classes: SyncClasses }) {
  const t = useTranslations("accountSync.data.classes")
  const engine = useAccountSyncStore((state) => state.engine)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggle = async (cls: keyof SyncClasses, on: boolean) => {
    if (!engine) return
    setBusy(true)
    setError(null)
    try {
      await engine.setClasses({ ...classes, [cls]: on })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <fieldset className="flex flex-col gap-2 pt-1" data-testid="account-sync-classes">
      <legend className="pb-1 text-xs font-medium text-muted-foreground">{t("title")}</legend>
      {(["content", "settings"] as const).map((cls) => (
        <label key={cls} className="flex items-start gap-2 text-sm">
          <Switch
            checked={classes[cls]}
            disabled={busy}
            onCheckedChange={(on) => void toggle(cls, on)}
            data-testid={`account-sync-class-${cls}`}
          />
          <span>
            <span className="font-medium">{t(cls)}</span>
            <span className="block text-[11px] text-muted-foreground">{t(`${cls}Hint`)}</span>
          </span>
        </label>
      ))}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {t("failed", { message: error })}
        </p>
      ) : null}
    </fieldset>
  )
}
