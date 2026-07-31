"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { PowerIcon } from "lucide-react"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { isTauri } from "@/lib/tauri"
import { onTauriEvent, TAURI_EVENTS } from "@/lib/tauri/events"
import {
  resolveCloseRequest,
  setCloseBehavior,
  type CloseBehavior,
} from "@/lib/tauri/close-behavior"
import { loggers } from "@cognia/logging"

/**
 * Global overlay (mounted once in `app/layout.tsx`, like `<ConsentOverlay/>`)
 * that prompts the user when the main window's close (X) button is pressed and
 * the persisted close behavior is `ask`. Rust has already prevented the close;
 * the chosen action is sent back through `resolve_close_request`.
 *
 * Renders nothing on web — the `app://close-requested` event only fires under
 * the desktop runtime.
 */
export function ExitConfirmationDialog() {
  const t = useTranslations("exitDialog")
  const [open, setOpen] = useState(false)
  const [remember, setRemember] = useState(false)

  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    let unlisten: (() => void) | undefined

    void onTauriEvent(TAURI_EVENTS.appCloseRequested, () => {
      // Reset the checkbox each time so a remembered choice is always a
      // deliberate per-prompt decision.
      setRemember(false)
      setOpen(true)
    }).then(
      (fn) => {
        if (cancelled) fn()
        else unlisten = fn
      },
      (err) => {
        loggers.app.warn("exitDialog.subscribeFailed", { err: String(err) })
      }
    )

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  const resolve = async (action: "minimize" | "quit", rememberAs: CloseBehavior) => {
    setOpen(false)
    try {
      if (remember) await setCloseBehavior(rememberAs)
      await resolveCloseRequest(action)
    } catch (err) {
      loggers.app.error("exitDialog.resolveFailed", err)
    }
  }

  const handleCancel = () => {
    setOpen(false)
    void resolveCloseRequest("cancel").catch((err) => {
      loggers.app.warn("exitDialog.cancelFailed", { err: String(err) })
    })
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia>
            <PowerIcon />
          </AlertDialogMedia>
          <AlertDialogTitle>{t("title")}</AlertDialogTitle>
          <AlertDialogDescription>{t("description")}</AlertDialogDescription>
        </AlertDialogHeader>

        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <Checkbox
            checked={remember}
            onCheckedChange={(checked) => setRemember(checked === true)}
            aria-label={t("remember")}
          />
          <span>{t("remember")}</span>
        </label>

        <AlertDialogFooter>
          <AlertDialogCancel onClick={handleCancel}>{t("cancel")}</AlertDialogCancel>
          <Button variant="secondary" onClick={() => void resolve("minimize", "tray")}>
            {t("minimizeToTray")}
          </Button>
          <Button variant="destructive" onClick={() => void resolve("quit", "quit")}>
            {t("quit")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
