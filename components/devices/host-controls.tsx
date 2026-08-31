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
 * why writing to a Host needs it active. Reading no longer does: the Runtime
 * card probes an inactive Host over its own transport.
 *
 * The health line is the other half. `connectionState` has carried `degraded`,
 * `versionMismatch` and `revoked` since ADR-0082, and `connectionError` has
 * carried the reason, and neither was rendered anywhere. The header counted
 * them (`summary.needsAttention`) and then offered connect / rename / remove,
 * so a host stuck mid-handshake looked exactly like one nobody had connected
 * yet. Each state now says what it is and offers the move that fits it:
 * reconnect for a transient failure, re-pair for a revoked device.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  KeyRoundIcon,
  PencilIcon,
  PlugIcon,
  PlugZapIcon,
  RefreshCwIcon,
  SlidersHorizontalIcon,
  TrashIcon,
} from "lucide-react"

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
import { SITE_TONE_DOT, SITE_TONE_TEXT } from "@/components/sites/site-status"
import type { DeviceRow } from "@/lib/devices/types"
import { useRemoteHostStore } from "@/stores/remote-host/remote-host-store"
import { cn } from "@/lib/utils"

import { DeviceSection } from "./device-section"
import { hostTone } from "./execution-host-switcher"

export interface HostControlsProps {
  row: DeviceRow
  /** Opens the add-host sheet, so a revoked host can be paired again in place. */
  onRepair?: () => void
}

export function HostControls({ row, onRepair }: HostControlsProps) {
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
  const state = row.connectionState ?? "disconnected"
  // `hostTone` is the switcher's map, reused so the popover and this card can
  // never disagree about what `degraded` looks like.
  const tone = hostTone({ connectionState: state } as never)
  // A host that threw this device out cannot be reconnected, only paired
  // again. Offering "Connect" there sends the user in a loop.
  const revoked = state === "revoked"
  const reconnectable = !connected && !revoked

  return (
    <DeviceSection
      id="host-controls"
      title={t("host.controls")}
      icon={SlidersHorizontalIcon}
      description={t("host.controlsHint")}
    >
      <div data-testid="device-host-controls">
        <div
          className="mb-3 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs"
          data-testid="host-connection-state"
          data-state={state}
        >
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden
              className={cn("inline-block size-1.5 rounded-full", SITE_TONE_DOT[tone])}
            />
            <span className={cn("font-medium", SITE_TONE_TEXT[tone])}>
              {t(`host.state.${state}`)}
            </span>
          </span>
          {/* Verbatim. "Could not reach it" and "it refused this device" need
              different fixes, and the message is what tells them apart. */}
          {row.connectionError ? (
            <span
              className="min-w-0 flex-1 text-muted-foreground"
              data-testid="host-connection-error"
            >
              {row.connectionError}
            </span>
          ) : null}
          {state === "versionMismatch" && row.serverVersion ? (
            <span className="text-muted-foreground" data-testid="host-version-mismatch">
              {t("host.serverVersion", { version: row.serverVersion })}
            </span>
          ) : null}
        </div>

        {draft === null ? (
          <div className="flex flex-wrap gap-2">
            {connected ? (
              <>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={deactivate}
                  data-testid="host-disconnect"
                >
                  <PlugIcon className="size-3.5" />
                  {t("host.disconnect")}
                </Button>
                {/* A connected host can still be degraded. Re-running the
                    handshake is the whole fix for a probe that failed once,
                    and there was no way to ask for it. */}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => activateHost(hostId)}
                  data-testid="host-reconnect"
                >
                  <RefreshCwIcon className="size-3.5" />
                  {t("host.reconnect")}
                </Button>
              </>
            ) : reconnectable ? (
              <Button size="sm" onClick={() => activateHost(hostId)} data-testid="host-connect">
                <PlugZapIcon className="size-3.5" />
                {t("host.connect")}
              </Button>
            ) : null}
            {revoked && onRepair ? (
              <Button size="sm" onClick={onRepair} data-testid="host-repair">
                <KeyRoundIcon className="size-3.5" />
                {t("host.repair")}
              </Button>
            ) : null}
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
          <div className="flex items-center gap-2">
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
      </div>
    </DeviceSection>
  )
}
