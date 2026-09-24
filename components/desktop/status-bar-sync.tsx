"use client"

/**
 * Status-bar device-sync segment (desktop only: `types/shell/bars.ts` marks
 * the `sync` item `desktopOnly`).
 *
 * The desktop is the sync HOST (ADR-0027 / ADR-0131): paired phones and
 * browsers pull from it through `companion://sync-pull-request`, answered by
 * `lib/sync/desktop-sync-source.ts`. This chip used to run the CLIENT
 * orchestrator (`runSyncDown`) on click instead. On Tauri that routes
 * `sync_pull` to a local command that does not exist, so every table failed,
 * `lastSyncAt` was never stamped, and the chip read "Not synced" forever while
 * a click only flashed a spinner.
 *
 * It now opens a popover that says what sync means on this machine:
 *  - host with paired devices: which devices are paired, which are connected
 *    right now (the Host's event-plane registry) and when each was last seen;
 *    "Sync now" publishes a `sync://invalidate` for every syncable table
 *    (`lib/sync/host-invalidate`), which makes every connected device pull
 *    immediately, and reports how many devices were asked;
 *  - host with no paired device: "Set up sync" opens Connectivity → Pairing;
 *  - steering a remote Host: devices sync with that Host, not this desktop
 *    (`publishSyncInvalidate` is a no-op here by design), so it explains that
 *    and links to Connectivity → Remote hosts.
 */

import { useCallback, useState, useSyncExternalStore } from "react"
import { useRouter } from "next/navigation"
import { useFormatter, useNow, useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import {
  AlertCircleIcon,
  CheckIcon,
  CloudOffIcon,
  RefreshCwIcon,
  ServerIcon,
  SettingsIcon,
  SmartphoneIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Separator } from "@/components/ui/separator"
import { eventPlaneState, type EventPlaneState } from "@/lib/companion/device-presence-registry"
import { listPairedDevices } from "@/lib/db/paired-devices"
import { settingsHref } from "@/lib/settings/deep-link"
import { SYNC_HANDLER_TABLES } from "@/lib/sync/companion-sync"
import { flushPendingSyncInvalidates, publishSyncInvalidate } from "@/lib/sync/host-invalidate"
import type { SyncableTable } from "@/lib/sync/types"
import { isRemoteHostActive, subscribeActiveRemoteTransport } from "@/lib/tauri/transport-routing"
import { cn } from "@/lib/utils"
import type { PairedDeviceRow } from "@/types/mobile/paired-device"

/** Re-read the in-memory event-plane registry (and relative times) on this cadence. */
const REFRESH_MS = 15_000
/** Device rows listed in the popover before collapsing into "+N more". */
const MAX_DEVICE_ROWS = 5

/** A device can hear a `sync://invalidate` frame only over a live event stream. */
export function canHearInvalidations(state: EventPlaneState): boolean {
  return state === "ready" || state === "replaying"
}

/** Paired, not revoked, not paused: the devices this Host still serves. */
export function activePairedDevices(rows: readonly PairedDeviceRow[]): PairedDeviceRow[] {
  return rows.filter((row) => row.revokedAt === undefined && row.pausedAt === undefined)
}

/**
 * Ask every connected device to pull every syncable table now. Coalesced
 * invalidations are flushed at once rather than after their 150 ms window, so
 * the request leaves before the popover reports it.
 */
export function requestDeviceSync(
  tables: readonly SyncableTable[] = SYNC_HANDLER_TABLES,
  publish: (table: SyncableTable) => void = publishSyncInvalidate,
  flush: () => void = flushPendingSyncInvalidates
): void {
  for (const table of tables) publish(table)
  flush()
}

type DevicesRead = { ok: true; devices: PairedDeviceRow[] } | { ok: false; error: string }

type SyncFeedback =
  | { kind: "idle" }
  | { kind: "requested"; count: number }
  | { kind: "none-connected" }
  | { kind: "error"; message: string }

function subscribeRemote(onChange: () => void): () => void {
  return subscribeActiveRemoteTransport(() => onChange())
}

export function StatusBarSync() {
  const t = useTranslations("desktop.statusBar")
  const format = useFormatter()
  // Re-renders on the cadence, which also re-reads the event-plane registry
  // (in-memory, no subscription of its own) during render.
  const now = useNow({ updateInterval: REFRESH_MS })
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [feedback, setFeedback] = useState<SyncFeedback>({ kind: "idle" })

  const remote = useSyncExternalStore(subscribeRemote, isRemoteHostActive, () => false)
  const read = useLiveQuery<DevicesRead>(
    () =>
      listPairedDevices().then(
        (rows): DevicesRead => ({ ok: true, devices: activePairedDevices(rows) }),
        (err: unknown): DevicesRead => ({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })
      ),
    []
  )
  const devices = read?.ok ? read.devices : []
  const at = now.getTime()
  const planes = new Map(
    devices.map((device) => [device.deviceId, eventPlaneState(device.deviceId, at)])
  )
  const connected = devices.filter((device) =>
    canHearInvalidations(planes.get(device.deviceId) ?? "disconnected")
  )
  const lastContact = devices.reduce<number | null>(
    (acc, device) => (acc === null ? device.lastSeenAt : Math.max(acc, device.lastSeenAt)),
    null
  )

  const openSettings = useCallback(
    (panel: "pairing" | "remote-hosts" | "overview") => {
      router.push(settingsHref("connectivity", { params: { connectivityPanel: panel } }))
      setOpen(false)
    },
    [router]
  )

  // Publishing is synchronous; the devices then pull in the background over
  // their own sync pipeline, so the result reported is who was asked.
  const onSyncNow = () => {
    try {
      if (connected.length === 0) {
        setFeedback({ kind: "none-connected" })
        return
      }
      requestDeviceSync()
      setFeedback({ kind: "requested", count: connected.length })
    } catch (err) {
      setFeedback({ kind: "error", message: err instanceof Error ? err.message : String(err) })
    }
  }

  const loading = read === undefined
  const readFailed = read !== undefined && !read.ok
  const state: "remote" | "loading" | "error" | "unpaired" | "paired" = remote
    ? "remote"
    : loading
      ? "loading"
      : readFailed
        ? "error"
        : devices.length === 0
          ? "unpaired"
          : "paired"

  const chipLabel =
    state === "remote"
      ? t("syncCenter.chip.remote")
      : state === "unpaired"
        ? t("syncCenter.chip.unpaired")
        : state === "paired"
          ? t("syncCenter.chip.paired", { connected: connected.length, total: devices.length })
          : state === "error"
            ? t("syncCenter.chip.error")
            : t("syncCenter.chip.loading")

  const Icon =
    state === "loading"
      ? RefreshCwIcon
      : state === "error"
        ? AlertCircleIcon
        : state === "remote"
          ? ServerIcon
          : state === "paired" && connected.length > 0
            ? CheckIcon
            : CloudOffIcon

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        // A fresh look at the popover starts without last time's result.
        if (next) setFeedback({ kind: "idle" })
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t("syncCenter.trigger", { status: chipLabel })}
          title={chipLabel}
          data-testid="status-sync"
          data-sync-state={state}
          className="flex h-6 shrink-0 items-center gap-1 px-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Icon
            aria-hidden
            className={cn(
              "size-3",
              state === "loading" && "animate-spin",
              state === "error" && "text-amber-500"
            )}
          />
          <span className="hidden max-w-[18ch] truncate lg:inline">{chipLabel}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        sideOffset={4}
        className="w-96 p-0"
        data-testid="status-sync-popover"
      >
        <PopoverHeader className="p-3">
          <PopoverTitle>{t("syncCenter.title")}</PopoverTitle>
          <PopoverDescription className="text-xs">
            {state === "remote"
              ? t("syncCenter.remoteDescription")
              : state === "unpaired"
                ? t("syncCenter.unpairedDescription")
                : state === "error"
                  ? t("syncCenter.readFailed")
                  : t("syncCenter.hostDescription")}
          </PopoverDescription>
        </PopoverHeader>

        {state === "paired" ? (
          <>
            <Separator />
            <div className="space-y-2 p-3 text-xs">
              <p className="text-muted-foreground" data-testid="status-sync-last-contact">
                {lastContact !== null && lastContact > 0
                  ? t("syncCenter.lastContact", {
                      time: format.relativeTime(new Date(lastContact), now),
                    })
                  : t("syncCenter.neverContacted")}
              </p>
              <ul className="space-y-1.5" data-testid="status-sync-devices">
                {devices.slice(0, MAX_DEVICE_ROWS).map((device) => {
                  const plane = planes.get(device.deviceId) ?? "disconnected"
                  return (
                    <li key={device.deviceId} className="flex items-center gap-2">
                      <SmartphoneIcon
                        aria-hidden
                        className="size-3.5 shrink-0 text-muted-foreground"
                      />
                      <span className="min-w-0 flex-1 truncate font-medium">{device.label}</span>
                      <span className="shrink-0 text-muted-foreground">
                        {device.lastSeenAt > 0
                          ? format.relativeTime(new Date(device.lastSeenAt), now)
                          : t("syncCenter.neverSeen")}
                      </span>
                      <Badge
                        variant={canHearInvalidations(plane) ? "secondary" : "outline"}
                        className="shrink-0 text-[10px]"
                      >
                        {t(`syncCenter.plane.${plane}`)}
                      </Badge>
                    </li>
                  )
                })}
              </ul>
              {devices.length > MAX_DEVICE_ROWS ? (
                <p className="text-muted-foreground">
                  {t("syncCenter.moreDevices", { count: devices.length - MAX_DEVICE_ROWS })}
                </p>
              ) : null}
            </div>
          </>
        ) : null}

        {state === "error" && read && !read.ok ? (
          <>
            <Separator />
            <p className="p-3 text-xs break-words text-muted-foreground">{read.error}</p>
          </>
        ) : null}

        <SyncFeedbackLine feedback={feedback} />

        <Separator />
        <div className="flex gap-2 p-2">
          {state === "paired" ? (
            <>
              <Button
                size="sm"
                className="flex-1"
                onClick={onSyncNow}
                data-testid="status-sync-now"
              >
                <RefreshCwIcon aria-hidden />
                {t("syncNow")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="flex-1"
                onClick={() => openSettings("pairing")}
              >
                <SettingsIcon aria-hidden />
                {t("syncCenter.manageDevices")}
              </Button>
            </>
          ) : state === "unpaired" ? (
            <Button
              size="sm"
              className="flex-1"
              onClick={() => openSettings("pairing")}
              data-testid="status-sync-setup"
            >
              <SmartphoneIcon aria-hidden />
              {t("syncCenter.setUp")}
            </Button>
          ) : state === "remote" ? (
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={() => openSettings("remote-hosts")}
            >
              <ServerIcon aria-hidden />
              {t("syncCenter.remoteSettings")}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={() => openSettings("overview")}
            >
              <SettingsIcon aria-hidden />
              {t("syncCenter.settings")}
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function SyncFeedbackLine({ feedback }: { feedback: SyncFeedback }) {
  const t = useTranslations("desktop.statusBar")
  if (feedback.kind === "idle") return null
  const tone =
    feedback.kind === "error"
      ? "text-destructive"
      : feedback.kind === "none-connected"
        ? "text-amber-600 dark:text-amber-400"
        : "text-muted-foreground"
  const text =
    feedback.kind === "requested"
      ? t("syncCenter.feedback.requested", { count: feedback.count })
      : feedback.kind === "none-connected"
        ? t("syncCenter.feedback.noneConnected")
        : t("syncCenter.feedback.failed", { error: feedback.message })
  return (
    <>
      <Separator />
      <p
        role="status"
        aria-live="polite"
        className={cn("p-3 text-xs", tone)}
        data-testid="status-sync-feedback"
        data-feedback={feedback.kind}
      >
        {text}
      </p>
    </>
  )
}
