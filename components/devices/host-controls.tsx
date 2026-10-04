"use client"

/**
 * A remote Host's lifecycle controls, in the device masthead.
 *
 * Absorbed from `components/settings/remote-hosts/tabs/hosts-tab.tsx` so the
 * console is the fleet view without the list in Settings staying behind as a
 * second place these actions live. Adding a Host and discovering one on the
 * LAN stay where they are; they are configuration.
 *
 * These used to be a card in the dashboard grid, the second one down. That put
 * "Connect", the one thing every visit to a host starts with, a scroll away
 * from the host's name, and below the identity record on a narrow pane. They
 * now sit beside the name, where the verb and its object read together and
 * stay on screen however far down the reader is.
 *
 * The visible buttons are the verbs that change what this window talks to:
 * connect, disconnect, reconnect, pair again. Rename and remove are rarer and
 * one of them is destructive, so they live behind the overflow menu, and
 * remove still asks. Connect, reconnect, disconnect and remove all go through
 * `useExecutionHostSwitch`, so none of them repoints the transport under a
 * running turn without saying so first.
 *
 * The health line ({@link HostConnectionState}) is the other half.
 * `connectionState` has carried `degraded`, `versionMismatch` and `revoked`
 * since ADR-0082 and nothing rendered it, so a host stuck mid-handshake looked
 * exactly like one nobody had connected yet. Each state now says what it is,
 * and the controls offer the move that fits it: reconnect for a transient
 * failure, re-pair for a revoked device. The verbatim error text is the
 * dashboard's connection alert, said once there rather than in both places.
 */

import Link from "next/link"
import { useRef } from "react"
import { useTranslations } from "next-intl"
import {
  KeyRoundIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlugIcon,
  PlugZapIcon,
  RefreshCwIcon,
  TrashIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { SITE_TONE_DOT, SITE_TONE_TEXT } from "@/components/sites/site-status"
import { useExecutionHostSwitch } from "@/hooks/devices/use-execution-host-switch"
import type { DeviceRow } from "@/lib/devices/types"
import { cn } from "@/lib/utils"

import { hostTone } from "./execution-host-switcher"

/** A `/pair` Host, which the remote-host store cannot address. */
export function isPairedCompanionHost(row: DeviceRow): boolean {
  return row.kind === "remote-host" && row.ref.startsWith("companion:")
}

/**
 * The host's handshake state, for the masthead's status line.
 *
 * Rendered for every remote host, store-managed or `/pair`, because both have
 * a handshake that can be half-done.
 */
export function HostConnectionState({ row }: { row: DeviceRow }) {
  const t = useTranslations("devices")
  if (row.kind !== "remote-host") return null
  const state = row.connectionState ?? "disconnected"
  // `hostTone` is the switcher's map, reused so the popover and the masthead
  // can never disagree about what `degraded` looks like.
  const tone = hostTone({ connectionState: state } as never)
  return (
    <span
      className="inline-flex items-center gap-1.5"
      data-testid="host-connection-state"
      data-state={state}
    >
      <span aria-hidden className={cn("inline-block size-1.5 rounded-full", SITE_TONE_DOT[tone])} />
      <span className={cn("font-medium", SITE_TONE_TEXT[tone])}>{t(`host.state.${state}`)}</span>
      {state === "versionMismatch" && row.serverVersion ? (
        <span className="text-muted-foreground" data-testid="host-version-mismatch">
          {t("host.serverVersion", { version: row.serverVersion })}
        </span>
      ) : null}
    </span>
  )
}

export interface HostControlsProps {
  row: DeviceRow
  /** Opens the add-host sheet, so a revoked host can be paired again in place. */
  onRepair?: () => void
  /** Turns the masthead title into the rename field. */
  onRename?: () => void
}

export function HostControls({ row, onRepair, onRename }: HostControlsProps) {
  const t = useTranslations("devices")
  // Every verb here moves the transport (or, for remove of the active host,
  // drops it), so each one goes through the shared in-flight guard. Remove
  // also always confirms, and that confirmation is the hook's dialog, so the
  // two questions arrive as one.
  const { requestSwitch, requestRemove, dialog } = useExecutionHostSwitch()
  /**
   * Set when Rename is picked, acted on once the menu has closed. The rename
   * field commits on blur, and while the menu is open its focus trap pulls
   * focus back out of anything that takes it, then hands it to the trigger on
   * close. Opening the field from `onSelect` therefore settled it (as a
   * cancel) before a key was pressed. Starting it from `onCloseAutoFocus`,
   * with the trigger's focus suppressed, lets the field keep its focus.
   */
  const renamePicked = useRef(false)

  if (isPairedCompanionHost(row)) {
    return (
      <div className="flex flex-wrap items-center gap-1.5" data-testid="device-host-controls">
        <Button size="sm" variant="outline" asChild>
          <Link href="/pair">{t("host.managePairing")}</Link>
        </Button>
      </div>
    )
  }
  if (row.kind !== "remote-host" || !row.hostId) return null
  const hostId = row.hostId
  const connected = row.runtime.isRoutingTarget
  const state = row.connectionState ?? "disconnected"
  // A host that threw this device out cannot be reconnected, only paired
  // again. Offering "Connect" there sends the user in a loop.
  const revoked = state === "revoked"
  const reconnectable = !connected && !revoked

  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="device-host-controls">
      {connected ? (
        <>
          {/* A connected host can still be degraded. Re-running the handshake
              is the whole fix for a probe that failed once, so it is the
              filled button then, and a quiet one on a healthy host, where it
              is not something to do. */}
          <Button
            size="sm"
            variant={state === "degraded" ? "default" : "outline"}
            onClick={() => void requestSwitch(hostId, { reconnect: true })}
            data-testid="host-reconnect"
          >
            <RefreshCwIcon className="size-3.5" />
            {t("host.reconnect")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void requestSwitch(null)}
            data-testid="host-disconnect"
          >
            <PlugIcon className="size-3.5" />
            {t("host.disconnect")}
          </Button>
        </>
      ) : reconnectable ? (
        <Button size="sm" onClick={() => void requestSwitch(hostId)} data-testid="host-connect">
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

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("host.moreAria", { label: row.label })}
            data-testid="host-more"
          >
            <MoreHorizontalIcon className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          onCloseAutoFocus={(event) => {
            if (!renamePicked.current) return
            renamePicked.current = false
            event.preventDefault()
            onRename?.()
          }}
        >
          {onRename ? (
            <DropdownMenuItem
              onSelect={() => {
                renamePicked.current = true
              }}
              data-testid="host-rename"
            >
              <PencilIcon className="size-3.5" />
              {t("host.rename")}
            </DropdownMenuItem>
          ) : null}
          {onRename ? <DropdownMenuSeparator /> : null}
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => void requestRemove(hostId)}
            aria-label={t("host.removeAria", { label: row.label })}
            data-testid="host-remove"
          >
            <TrashIcon className="size-3.5" />
            {t("host.remove")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {dialog}
    </div>
  )
}
