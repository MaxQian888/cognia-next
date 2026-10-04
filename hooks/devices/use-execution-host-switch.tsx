"use client"

/**
 * The one way a user-initiated action changes which machine this window
 * drives: switch to a remote host, return to local, reconnect, or forget a
 * host.
 *
 * Activating a remote host repoints every `target: "execution"` command at
 * another machine (ADR-0082). Doing that under a live turn strands the turn on
 * a host the UI has stopped addressing: no error, just a conversation that
 * never finishes. `ExecutionHostSwitcher` asked first, but it was one of seven
 * places that could move the transport. The settings registry's Connect, the
 * device masthead's Connect / Reconnect / Disconnect, the runtime section's
 * "activate", "connect after pairing", the workflow handoff's "open target"
 * and the GitHub runner's Connect all called the store directly and skipped
 * the question. A guard that only some paths pass through is not a guard, so
 * the check and its dialog live here and every one of those paths calls in.
 *
 * Two shapes of request:
 *
 *  * `requestSwitch(hostId | null)` changes the active host, or with
 *    `reconnect` re-runs the handshake on the active one. Reconnecting is a
 *    switch too: `activateHost` installs a fresh transport and disposes the
 *    old one, which is exactly what strands an in-flight turn.
 *  * `requestRemove(hostId)` always confirms, because forgetting a host also
 *    drops its stored credential and there is no undo. When the host is the
 *    active one, removing it deactivates first, so the same in-flight check
 *    runs and its warning is folded into the one removal dialog rather than
 *    stacking a second dialog on top of it.
 *
 * Deliberately NOT routed through here: automatic deactivation that nobody
 * asked for (a GitHub runner lease that stopped or failed). The machine behind
 * it is already gone, so any turn on it is already lost, and asking "switch
 * anyway?" about a host that no longer exists would leave every call pointed
 * at a dead transport until someone answered.
 *
 * The run check is a lazy import read at request time, never a subscription:
 * this hook is mounted in the desktop status bar on every route, and
 * subscribing to chat state there would re-render the bar on every streamed
 * token (see `lib/devices/execution-host-guard.ts`).
 */

import { useCallback, useRef, useState, type ReactElement } from "react"
import { useTranslations } from "next-intl"

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
import { useRemoteHostStore } from "@/stores/remote-host/remote-host-store"

export interface ExecutionHostSwitchOptions {
  /**
   * Re-run the handshake even when `hostId` is already the active host. This
   * is the masthead's Reconnect; without it a request for the current host is
   * a no-op that reports `unchanged`.
   */
  reconnect?: boolean
  /**
   * Runs once the requested host is the one being driven: straight away,
   * after the user confirms, or immediately when it already was. Callers that
   * navigate to the target (the workflow handoff) navigate here, so a
   * cancelled switch does not leave the user on a page for a host they are
   * not driving.
   */
  onSwitched?: () => void
  /**
   * Runs exactly once when the request is finished either way, with whether
   * the switch happened. "Connect after pairing" closes its sheet here, so a
   * confirmation dialog rendered inside the sheet is answered before the sheet
   * unmounts it.
   */
  onSettled?: (switched: boolean) => void
}

export interface ExecutionHostRemoveOptions {
  /** Runs after the host is forgotten. Not called when the user cancels. */
  onRemoved?: () => void
}

/**
 * What a switch request did. `confirming` means the dialog is up and the
 * answer arrives through the callbacks; `unknown-host` is an id that is not in
 * the registry (removed in another window, or a stale row).
 */
export type ExecutionHostSwitchOutcome = "switched" | "unchanged" | "confirming" | "unknown-host"

export interface ExecutionHostSwitch {
  requestSwitch: (
    hostId: string | null,
    options?: ExecutionHostSwitchOptions
  ) => Promise<ExecutionHostSwitchOutcome>
  requestRemove: (hostId: string, options?: ExecutionHostRemoveOptions) => Promise<void>
  /** The confirmation dialog. Render it once, anywhere in the caller's tree. */
  dialog: ReactElement
}

type Pending =
  | {
      kind: "switch"
      hostId: string | null
      label: string
      reconnect: boolean
      options: ExecutionHostSwitchOptions
    }
  | {
      kind: "remove"
      hostId: string
      label: string
      /** The host being removed is the one this window drives. */
      active: boolean
      /** ...and a turn is in flight on it. */
      busy: boolean
      options: ExecutionHostRemoveOptions
    }

async function runActive(): Promise<boolean> {
  const { anyRunActive } = await import("@/lib/devices/execution-host-guard")
  return anyRunActive()
}

export function useExecutionHostSwitch(): ExecutionHostSwitch {
  const t = useTranslations("devices")
  // The store is read at request time (`getState()`), never subscribed. Two
  // reasons. A caller that has just registered a host (`addHost`, then "connect
  // after pairing") asks for it before React has re-rendered, so a subscribed
  // `hosts` would not contain it yet and the request would be refused as an
  // unknown host. And this hook sits in the status bar on every route, where a
  // subscription to the whole host list would re-render the bar on every
  // connection-state tick for nothing this hook draws.
  const [pending, setPending] = useState<Pending | null>(null)
  /**
   * What the dialog shows. Replaced when a request opens it and deliberately
   * NOT cleared when it closes, so the copy stays on screen through the close
   * animation instead of collapsing to an empty box as it fades.
   */
  const [shown, setShown] = useState<Pending | null>(null)
  /**
   * Mirrors `pending` for the dialog's handlers. Radix fires the action's
   * `onClick` and then `onOpenChange(false)` from the same click, both closing
   * over the render that showed the dialog; settling through the ref is what
   * makes the second one a no-op instead of reporting a confirmed switch as
   * also cancelled. Written only from handlers, never during render.
   */
  const pendingRef = useRef<Pending | null>(null)

  const open = useCallback((next: Pending) => {
    // A second request while one is still on screen replaces it. The first is
    // answered as "did not happen", so its caller is never left waiting.
    const previous = pendingRef.current
    pendingRef.current = next
    setPending(next)
    setShown(next)
    if (previous?.kind === "switch") previous.options.onSettled?.(false)
  }, [])

  const commitSwitch = useCallback((hostId: string | null) => {
    const store = useRemoteHostStore.getState()
    if (hostId === null) store.deactivate()
    else store.activateHost(hostId)
  }, [])

  const requestSwitch = useCallback(
    async (
      hostId: string | null,
      options: ExecutionHostSwitchOptions = {}
    ): Promise<ExecutionHostSwitchOutcome> => {
      const { hosts, activeHostId } = useRemoteHostStore.getState()
      const host = hostId === null ? null : hosts.find((candidate) => candidate.id === hostId)
      if (hostId !== null && !host) {
        options.onSettled?.(false)
        return "unknown-host"
      }
      const already = hostId === activeHostId
      // "Reconnect" to local has nothing to re-run: the local transport has no
      // handshake, so it is the same no-op as asking for where you already are.
      const reconnect = Boolean(options.reconnect) && hostId !== null
      if (already && !reconnect) {
        options.onSwitched?.()
        options.onSettled?.(true)
        return "unchanged"
      }
      if (await runActive()) {
        open({
          kind: "switch",
          hostId,
          label: host ? host.label : t("executionHost.local"),
          reconnect: already && reconnect,
          options,
        })
        return "confirming"
      }
      commitSwitch(hostId)
      options.onSwitched?.()
      options.onSettled?.(true)
      return "switched"
    },
    [commitSwitch, open, t]
  )

  const requestRemove = useCallback(
    async (hostId: string, options: ExecutionHostRemoveOptions = {}) => {
      const { hosts, activeHostId } = useRemoteHostStore.getState()
      const host = hosts.find((candidate) => candidate.id === hostId)
      if (!host) return
      const active = hostId === activeHostId
      // Only the active host can strand a turn: removing an idle registry row
      // changes nothing about where calls land.
      const busy = active ? await runActive() : false
      open({ kind: "remove", hostId, label: host.label, active, busy, options })
    },
    [open]
  )

  const settle = useCallback(
    (confirmed: boolean) => {
      const current = pendingRef.current
      if (!current) return
      pendingRef.current = null
      setPending(null)
      if (current.kind === "switch") {
        if (confirmed) {
          commitSwitch(current.hostId)
          current.options.onSwitched?.()
        }
        current.options.onSettled?.(confirmed)
        return
      }
      if (confirmed) {
        useRemoteHostStore.getState().removeHost(current.hostId)
        current.options.onRemoved?.()
      }
    },
    [commitSwitch]
  )

  const dialog = (
    <AlertDialog
      open={pending !== null}
      onOpenChange={(next) => {
        if (!next) settle(false)
      }}
    >
      <AlertDialogContent data-testid="execution-host-switch-dialog">
        {/* Nothing is built before the first request: this hook is mounted
            in the status bar on every route, and there is no reason to format
            dialog copy that nobody has asked for. */}
        {shown === null ? null : shown.kind === "remove" ? (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("host.removeTitle")}</AlertDialogTitle>
              <AlertDialogDescription>
                {t("host.removeBody", { label: shown.label })}
              </AlertDialogDescription>
              {shown.active ? (
                // The consequence a removal has beyond the registry: this
                // window stops driving the host at once.
                <p
                  className="text-sm text-muted-foreground"
                  data-testid="execution-host-remove-active"
                >
                  {shown.busy
                    ? t("executionHost.removeActiveBusy", { label: shown.label })
                    : t("executionHost.removeActive", { label: shown.label })}
                </p>
              ) : null}
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("host.cancel")}</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() => settle(true)}
                data-testid="host-remove-confirm"
              >
                {t("host.remove")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        ) : (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {shown.reconnect
                  ? t("executionHost.reconnectTitle")
                  : t("executionHost.confirmTitle")}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {shown.reconnect
                  ? t("executionHost.reconnectBody", { label: shown.label })
                  : t("executionHost.confirmBody", { label: shown.label })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("executionHost.confirmCancel")}</AlertDialogCancel>
              <AlertDialogAction onClick={() => settle(true)} data-testid="execution-host-confirm">
                {shown.reconnect
                  ? t("executionHost.reconnectConfirm")
                  : t("executionHost.confirmSwitch")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  )

  return { requestSwitch, requestRemove, dialog }
}
