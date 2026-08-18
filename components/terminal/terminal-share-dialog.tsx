"use client"

/**
 * Share a hosted terminal session with paired devices (ADR-0133, design A).
 *
 * Sharing is not a new transport and mints no links: a paired device that
 * holds the remote-terminal grant attaches to the durable host through the
 * existing LAN/WAN adapters and contends for the same controller lease the
 * desktop uses. This dialog is therefore two lists over facts the host and the
 * pairing store already own:
 *
 *   * **In this session** — the host's participant roster for the active
 *     session (`SessionInfo.participants`), live via the session registry;
 *   * **Paired devices** — every paired device with its remote-terminal grant
 *     as a switch. Flipping it drives the SAME flow as the paired-devices card
 *     (`useRemoteTerminalGrantToggle`): provision → mirror → host. Removing
 *     the grant is the "kick": the adapters recheck it every second and drop
 *     the attachment.
 *
 * The grant is device-wide (every hosted session), not per session — the
 * dialog says so rather than implying a session-scoped invite. When the
 * host's remote access is off nothing can attach; the dialog links to the
 * setting instead of flipping it (that switch also re-provisions the host).
 */

import * as React from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { useRouter } from "next/navigation"
import { Share2Icon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Switch } from "@/components/ui/switch"
import {
  useDeviceGrants,
  useRemoteTerminalGrantToggle,
} from "@/hooks/companion/use-remote-terminal-grant"
import { listPairedDevices } from "@/lib/db/paired-devices"
import {
  mergeDevicesWithRoster,
  participantLabel,
  projectRoster,
  type SessionRoster,
} from "@/lib/terminal/collaboration/roster"
import { getLiveSession, subscribeLiveSessions } from "@/lib/terminal/session-registry"
import { isTauri } from "@/lib/tauri"
import { cn } from "@/lib/utils"
import { useSettingsStore } from "@/stores/settings"
import type { PairedDeviceRow } from "@/types/mobile/paired-device"

const ROSTER_CACHE = new Map<string, { key: string; roster: SessionRoster }>()

/**
 * Identity-stable roster snapshot for `useSyncExternalStore` (same contract as
 * the chip's `sessionFactsSnapshot`): a new object only when the roster's
 * content changes, never per call.
 */
export function sessionRosterSnapshot(sessionId: string): SessionRoster | null {
  const info = getLiveSession(sessionId)?.info
  if (!info) {
    ROSTER_CACHE.delete(sessionId)
    return null
  }
  const roster = projectRoster(info)
  const key = [
    roster.known,
    roster.controllerId,
    roster.attachedCount,
    ...roster.participants.map((p) => `${p.clientId}:${p.role}:${p.local}`),
  ].join("|")
  const cached = ROSTER_CACHE.get(sessionId)
  if (cached && cached.key === key) return cached.roster
  const frozen = Object.freeze(roster)
  ROSTER_CACHE.set(sessionId, { key, roster: frozen })
  return frozen
}

/** Live roster for one session; `null` when it is not registered. */
export function useSessionRoster(sessionId: string): SessionRoster | null {
  const getSnapshot = React.useCallback(() => sessionRosterSnapshot(sessionId), [sessionId])
  return React.useSyncExternalStore(subscribeLiveSessions, getSnapshot, () => null)
}

export interface TerminalShareDialogProps {
  sessionId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Injected in tests; defaults to the Dexie paired-devices table. */
  listDevices?: () => Promise<PairedDeviceRow[]>
}

export function TerminalShareDialog({
  sessionId,
  open,
  onOpenChange,
  listDevices = listPairedDevices,
}: TerminalShareDialogProps) {
  const t = useTranslations("terminal.share")
  const router = useRouter()
  const roster = useSessionRoster(sessionId)
  const devices = useLiveQuery(() => listDevices(), [listDevices], [] as PairedDeviceRow[])
  const { grants, refresh: refreshGrants } = useDeviceGrants()
  const toggleGrant = useRemoteTerminalGrantToggle(refreshGrants)
  const remoteAccessEnabled = useSettingsStore(
    (state) => state.settings?.terminal?.host?.allowRemoteAccess === true
  )
  const [busyDeviceId, setBusyDeviceId] = React.useState<string | null>(null)

  const rows = React.useMemo(
    () => mergeDevicesWithRoster(devices ?? [], grants, roster ?? { participants: [] }),
    [devices, grants, roster]
  )
  const canGrant = isTauri()

  const onToggle = React.useCallback(
    async (row: (typeof rows)[number], next: boolean) => {
      const device = (devices ?? []).find((d) => d.deviceId === row.deviceId)
      if (!device) return
      setBusyDeviceId(row.deviceId)
      try {
        await toggleGrant(device.deviceId, device.pubkey, device.label, next)
      } finally {
        setBusyDeviceId(null)
      }
    },
    [devices, toggleGrant]
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="terminal-share-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Share2Icon className="h-4 w-4" aria-hidden />
            {t("title")}
          </DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        {!remoteAccessEnabled ? (
          <div
            className="flex items-start justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs"
            role="status"
            data-testid="terminal-share-remote-access-off"
          >
            <p>{t("remoteAccessOff")}</p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 shrink-0 text-[11px]"
              onClick={() => {
                onOpenChange(false)
                router.push("/settings?section=terminal")
              }}
            >
              {t("openTerminalSettings")}
            </Button>
          </div>
        ) : null}

        <section className="space-y-2" aria-labelledby="terminal-share-participants">
          <h3 id="terminal-share-participants" className="text-xs font-medium">
            {t("participants.title")}
          </h3>
          {!roster ? (
            <p className="text-xs text-muted-foreground">{t("participants.notLive")}</p>
          ) : !roster.known ? (
            <p
              className="text-xs text-muted-foreground"
              data-testid="terminal-share-roster-unknown"
            >
              {t("participants.unknown", { count: roster.attachedCount })}
            </p>
          ) : (
            <ul className="space-y-1" data-testid="terminal-share-participants">
              {roster.participants.map((participant) => (
                <li
                  key={participant.clientId}
                  className="flex items-center justify-between gap-2 rounded border px-2 py-1 text-xs"
                  data-client-id={participant.clientId}
                >
                  <span className="truncate">
                    {participantLabel(participant, devices ?? [], t("participants.thisDevice"))}
                  </span>
                  <Badge
                    variant={participant.role === "controller" ? "default" : "secondary"}
                    className="text-[10px]"
                  >
                    {participant.role === "controller"
                      ? t("participants.controller")
                      : t("participants.viewer")}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="space-y-2" aria-labelledby="terminal-share-devices">
          <div className="flex items-baseline justify-between gap-2">
            <h3 id="terminal-share-devices" className="text-xs font-medium">
              {t("devices.title")}
            </h3>
            <p className="text-[11px] text-muted-foreground">{t("devices.scope")}</p>
          </div>
          {rows.length === 0 ? (
            <div className="flex items-center justify-between gap-3 rounded-md border border-dashed p-3 text-xs text-muted-foreground">
              <p>{t("devices.empty")}</p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 shrink-0 text-[11px]"
                onClick={() => {
                  onOpenChange(false)
                  router.push("/settings?section=companion")
                }}
              >
                {t("devices.pair")}
              </Button>
            </div>
          ) : (
            <ul className="space-y-1" data-testid="terminal-share-devices">
              {rows.map((row) => (
                <li
                  key={row.deviceId}
                  className={cn(
                    "flex items-center justify-between gap-3 rounded border px-2 py-1.5 text-xs",
                    row.blocked && "opacity-60"
                  )}
                  data-testid={`terminal-share-device-${row.deviceId}`}
                >
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{row.label}</span>
                      {row.attached ? (
                        <Badge
                          variant={row.role === "controller" ? "default" : "secondary"}
                          className="text-[10px]"
                        >
                          {row.role === "controller"
                            ? t("participants.controller")
                            : t("devices.attached")}
                        </Badge>
                      ) : null}
                      {row.blocked ? (
                        <Badge variant="outline" className="text-[10px]">
                          {t("devices.blocked")}
                        </Badge>
                      ) : null}
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      {row.terminalGranted ? t("devices.granted") : t("devices.notGranted")}
                    </p>
                  </div>
                  <Switch
                    checked={row.terminalGranted}
                    disabled={!canGrant || row.blocked || busyDeviceId === row.deviceId}
                    onCheckedChange={(next) => void onToggle(row, next)}
                    aria-label={t("devices.toggleAria", { label: row.label })}
                    data-testid={`terminal-share-grant-${row.deviceId}`}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
      </DialogContent>
    </Dialog>
  )
}
