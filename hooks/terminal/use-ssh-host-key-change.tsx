"use client"

/**
 * The one place a changed SSH host key is adjudicated.
 *
 * TOFU fails closed, which is correct, but the refusal arrives as the string
 * `ssh_host_key_changed:{…}` on a failed spawn, and only one of the three
 * places that spawn an SSH session knew what to do with it. Settings decoded
 * it, showed both fingerprints and offered a deliberate re-trust. The device
 * console printed the raw JSON into an error paragraph, and the terminal dock
 * put it in a toast. From either of those, a user whose server had been
 * rebuilt had no way forward at all, and no indication that a way existed
 * somewhere else in the app.
 *
 * So the flow lives here and the three sites mount it. Settings keeps its exact
 * behaviour by becoming this hook's first consumer rather than a second
 * implementation of it.
 *
 * The hook hands back the dialog itself rather than the state to build one.
 * Mounting is the step that was missing, and returning an element is the shape
 * where it cannot be forgotten.
 */

import { useCallback, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { SshHostKeyDialog } from "@/components/settings/terminal/ssh-host-key-dialog"
import { isTauri } from "@/lib/platform/detect"
import {
  forgetSshHostKey,
  parseHostKeyChange,
  type SshHostKeyChange,
} from "@/lib/terminal/ssh-host-key"

export interface UseSshHostKeyChangeResult {
  /**
   * Offer a failed connection's message to the guard.
   *
   * Returns `true` when it was a host-key change and the dialog has taken it,
   * so the caller skips its own error path. Returns `false` for every other
   * failure, which the caller still owns: this guard knows about exactly one.
   */
  capture: (message: unknown) => boolean
  /** Mount this. It renders nothing until something is captured. */
  dialog: React.ReactNode
  /** The pending mismatch, for a caller that wants to suppress other UI. */
  change: SshHostKeyChange | null
}

export interface UseSshHostKeyChangeOptions {
  /** Run after the old key is forgotten, typically to retry the connection. */
  onForgotten?: (change: SshHostKeyChange) => void
}

export function useSshHostKeyChange(
  options: UseSshHostKeyChangeOptions = {}
): UseSshHostKeyChangeResult {
  const t = useTranslations("settings.terminal.ssh")
  const [change, setChange] = useState<SshHostKeyChange | null>(null)
  const { onForgotten } = options

  /**
   * `isTauri()` is the right question here, and one of the few places it is.
   *
   * `ssh_forget_host_key` is `target: "client"` with `transports: ["internal"]`,
   * so `transport.call` refuses it with `command_transport_forbidden` from a
   * companion rather than forwarding it to the host. The mismatch is still
   * worth showing everywhere, because both fingerprints are exactly what the
   * user needs in order to go and check. Only the decision is desktop-bound.
   */
  const canTrust = isTauri()

  const capture = useCallback((message: unknown) => {
    const parsed = parseHostKeyChange(message)
    if (!parsed) return false
    setChange(parsed)
    return true
  }, [])

  const dialog = useMemo(
    () => (
      <SshHostKeyDialog
        change={change}
        canTrust={canTrust}
        unavailableReason={canTrust ? undefined : t("hostKeyChanged.desktopOnly")}
        onDismiss={() => setChange(null)}
        onTrust={async (pending) => {
          try {
            await forgetSshHostKey(pending.host, pending.port)
            setChange(null)
            toast.success(t("toasts.hostKeyForgotten"))
            onForgotten?.(pending)
          } catch (error) {
            toast.error(t("toasts.hostKeyForgetFailed"), {
              description: error instanceof Error ? error.message : String(error),
            })
          }
        }}
      />
    ),
    [canTrust, change, onForgotten, t]
  )

  return { capture, dialog, change }
}
