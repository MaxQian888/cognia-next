"use client"

/**
 * The lifecycle controls a remote Host row owns: connect, rename, remove.
 *
 * Absorbed from `components/settings/remote-hosts/tabs/hosts-tab.tsx` so the
 * console can be the fleet view without the list in Settings having to stay
 * behind as a second place these actions live. Adding a Host and discovering
 * one on the LAN stay in Settings — those are configuration, and a wizard is
 * not a fleet view.
 *
 * Connecting is what makes a Host the transport's execution target, which is
 * why the Runtime tab's workspace list becomes readable only once it is
 * active; the same store call backs both.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { PencilIcon, PlugIcon, PlugZapIcon, TrashIcon } from "lucide-react"

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
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { DeviceRow } from "@/lib/devices/types"
import { useRemoteHostStore } from "@/stores/remote-host/remote-host-store"

export function HostControls({ row }: { row: DeviceRow }) {
  const t = useTranslations("devices")
  const activateHost = useRemoteHostStore((state) => state.activateHost)
  const deactivate = useRemoteHostStore((state) => state.deactivate)
  const removeHost = useRemoteHostStore((state) => state.removeHost)
  const updateHostLabel = useRemoteHostStore((state) => state.updateHostLabel)

  const [draft, setDraft] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)

  if (row.kind !== "remote-host" || !row.hostId) return null
  const hostId = row.hostId
  const connected = row.runtime.isRoutingTarget

  return (
    <section className="rounded-md border p-3" data-testid="device-host-controls">
      <h3 className="text-sm font-medium">{t("host.controls")}</h3>
      <p className="mt-1 text-xs text-muted-foreground">{t("host.controlsHint")}</p>

      {draft === null ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {connected ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={deactivate}
              data-testid="host-disconnect"
            >
              <PlugIcon className="size-3.5" />
              {t("host.disconnect")}
            </Button>
          ) : (
            <Button size="sm" onClick={() => activateHost(hostId)} data-testid="host-connect">
              <PlugZapIcon className="size-3.5" />
              {t("host.connect")}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setDraft(row.label)}
            data-testid="host-rename"
          >
            <PencilIcon className="size-3.5" />
            {t("host.rename")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive"
            onClick={() => setConfirmRemove(true)}
            aria-label={t("host.removeAria", { label: row.label })}
            data-testid="host-remove"
          >
            <TrashIcon className="size-3.5" />
            {t("host.remove")}
          </Button>
        </div>
      ) : (
        <div className="mt-2 flex items-center gap-2">
          <Input
            aria-label={t("host.renameLabel")}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            className="h-8"
            data-testid="host-rename-input"
          />
          <Button
            size="sm"
            variant="secondary"
            // An empty label would leave a row that cannot be told apart from
            // any other unnamed host, so it is simply not a rename.
            disabled={draft.trim().length === 0}
            onClick={() => {
              updateHostLabel(hostId, draft.trim())
              setDraft(null)
            }}
            data-testid="host-rename-save"
          >
            {t("host.save")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
            {t("host.cancel")}
          </Button>
        </div>
      )}

      <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("host.removeTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("host.removeBody", { label: row.label })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("host.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                removeHost(hostId)
                setConfirmRemove(false)
              }}
              data-testid="host-remove-confirm"
            >
              {t("host.remove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
