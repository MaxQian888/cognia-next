"use client"

// Restore a snapshot from the WebDAV server. Always user-initiated and
// explicitly confirmed (restore overwrites/merges local data). Reuses the
// shared import pipeline via `restoreFromWebDav`.

import { useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { PassphraseInput } from "@/components/data/shared/passphrase-input"
import { ImportSummary as ImportSummaryView } from "./import-summary"
import { listRemoteSnapshots, restoreFromWebDav, type RemoteSnapshot } from "@/lib/webdav/restore"
import type { ImportMergeStrategy, ImportSummary } from "@/lib/data/types"

const LATEST_VALUE = "__latest__"

type Phase =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; snapshots: RemoteSnapshot[] }
  | { status: "restoring" }
  | { status: "done"; summary: ImportSummary }
  | { status: "error"; message: string }

interface Props {
  /** Trigger element (uncontrolled mode). Omit when driving via `open`. */
  trigger?: ReactNode
  /** Controlled open state — provide together with `onOpenChange`. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

export function WebDavRestoreDialog({
  trigger,
  open: openProp,
  onOpenChange: onOpenChangeProp,
}: Props) {
  const t = useTranslations("settings.data.webdav.restoreDialog")
  const [openState, setOpenState] = useState(false)
  const controlled = openProp !== undefined
  const open = controlled ? openProp : openState
  const [phase, setPhase] = useState<Phase>({ status: "idle" })
  const [selected, setSelected] = useState<string>(LATEST_VALUE)
  const [strategy, setStrategy] = useState<ImportMergeStrategy>("skip")
  const [passphrase, setPassphrase] = useState("")

  const onOpenChange = (next: boolean) => {
    if (controlled) onOpenChangeProp?.(next)
    else setOpenState(next)
    if (next) void loadSnapshots()
    else {
      setPhase({ status: "idle" })
      setPassphrase("")
      setSelected(LATEST_VALUE)
    }
  }

  const loadSnapshots = async () => {
    setPhase({ status: "loading" })
    try {
      const snapshots = await listRemoteSnapshots()
      setPhase({ status: "ready", snapshots })
    } catch (err) {
      setPhase({ status: "error", message: err instanceof Error ? err.message : String(err) })
    }
  }

  const onRestore = async () => {
    if (!passphrase) return
    setPhase({ status: "restoring" })
    try {
      const path = selected === LATEST_VALUE ? undefined : selected
      const summary = await restoreFromWebDav({ path, passphrase, mergeStrategy: strategy })
      setPhase({ status: "done", summary })
    } catch (err) {
      setPhase({ status: "error", message: err instanceof Error ? err.message : String(err) })
    }
  }

  const busy = phase.status === "loading" || phase.status === "restoring"
  const snapshots = phase.status === "ready" ? phase.snapshots : []

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        {phase.status === "loading" && (
          <p className="text-xs italic text-muted-foreground">{t("loading")}</p>
        )}

        {phase.status === "ready" && snapshots.length === 0 && (
          <p className="text-xs text-muted-foreground">{t("noSnapshots")}</p>
        )}

        {phase.status === "ready" && snapshots.length > 0 && (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs">{t("snapshotLabel")}</Label>
              <Select value={selected} onValueChange={setSelected}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={LATEST_VALUE}>{t("latest")}</SelectItem>
                  {snapshots
                    .filter((s) => !s.isLatestPointer)
                    .map((s) => (
                      <SelectItem key={s.path} value={s.path}>
                        {s.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label className="text-xs">{t("strategyLabel")}</Label>
              <Select value={strategy} onValueChange={(v) => setStrategy(v as ImportMergeStrategy)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="skip">{t("strategySkip")}</SelectItem>
                  <SelectItem value="overwrite">{t("strategyOverwrite")}</SelectItem>
                  <SelectItem value="duplicate">{t("strategyDuplicate")}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <PassphraseInput value={passphrase} onChange={setPassphrase} autoFocus />
          </div>
        )}

        {phase.status === "restoring" && (
          <p className="text-xs italic text-muted-foreground">{t("restoring")}</p>
        )}

        {phase.status === "done" && <ImportSummaryView summary={phase.summary} />}

        {phase.status === "error" && (
          <p className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
            {t("failed", { error: phase.message })}
          </p>
        )}

        <DialogFooter>
          {(phase.status === "ready" || phase.status === "error") && (
            <Button
              size="sm"
              disabled={busy || !passphrase || snapshots.length === 0}
              onClick={() => void onRestore()}
            >
              {t("restoreButton")}
            </Button>
          )}
          {phase.status === "done" && (
            <Button size="sm" variant="outline" onClick={() => onOpenChange(false)}>
              {t("close")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
