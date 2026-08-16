"use client"

/**
 * Warning shown when a saved SSH host presents a different key than the one
 * that was trusted on first connect.
 *
 * Deliberately an `AlertDialog` rather than a toast: the connection has already
 * been refused, and the only way forward is a decision the user has to make
 * with both fingerprints in front of them. Re-trusting is the destructive
 * action, so it is the non-default button and never the one focus lands on.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { ShieldAlertIcon } from "lucide-react"

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
import type { SshHostKeyChange } from "@/lib/terminal/ssh-host-key"

export interface SshHostKeyDialogProps {
  /** The mismatch to explain. `null` keeps the dialog closed. */
  change: SshHostKeyChange | null
  /** Dismiss without changing what is trusted. */
  onDismiss: () => void
  /** Forget the stored key so the next connection re-learns this one. */
  onTrust: (change: SshHostKeyChange) => Promise<void> | void
}

export function SshHostKeyDialog({ change, onDismiss, onTrust }: SshHostKeyDialogProps) {
  const t = useTranslations("settings.terminal.ssh.hostKeyChanged")
  const [busy, setBusy] = useState(false)

  async function trust(): Promise<void> {
    if (!change) return
    setBusy(true)
    try {
      await onTrust(change)
    } catch {
      // Reporting is the caller's job — it knows whether a failed re-trust is
      // a toast, a log, or a retry. Swallowing here only keeps a rejection
      // from escaping as an unhandled promise; the `finally` still re-enables
      // the buttons so the user can retry or back out.
    } finally {
      setBusy(false)
    }
  }

  return (
    <AlertDialog
      open={change !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onDismiss()
      }}
    >
      <AlertDialogContent data-testid="ssh-host-key-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <ShieldAlertIcon className="h-4 w-4 text-destructive" />
            {t("title")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {change ? t("body", { host: change.host, port: change.port }) : null}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <dl className="space-y-2 rounded border p-2.5 text-xs">
          <div className="space-y-0.5">
            <dt className="text-[11px] text-muted-foreground">{t("expected")}</dt>
            <dd className="font-mono break-all" data-testid="ssh-host-key-expected">
              {change?.knownFingerprint ?? t("unknownFingerprint")}
            </dd>
          </div>
          <div className="space-y-0.5">
            <dt className="text-[11px] text-muted-foreground">{t("presented")}</dt>
            <dd
              className="font-mono break-all text-destructive"
              data-testid="ssh-host-key-presented"
            >
              {change?.presentedFingerprint}
            </dd>
          </div>
        </dl>

        <p className="text-[11px] text-muted-foreground">{t("guidance")}</p>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy} data-testid="ssh-host-key-cancel">
            {t("cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            onClick={(event) => {
              // Keep the dialog mounted through the await so the button can
              // stay disabled; the caller closes it once the key is forgotten.
              event.preventDefault()
              void trust()
            }}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            data-testid="ssh-host-key-trust"
          >
            {busy ? t("trusting") : t("trust")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export default SshHostKeyDialog
