"use client"

import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react"
import { Dialog as DialogPrimitive } from "radix-ui"
import { useTranslations } from "next-intl"
import { Flashlight, FlashlightOff, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Dialog, DialogDescription, DialogPortal, DialogTitle } from "@/components/ui/dialog"
import { useBackDismiss } from "@/hooks/ui/use-back-dismiss"
import {
  getBarcodeScanServerSnapshot,
  getBarcodeScanSnapshot,
  registerBarcodeScanHost,
  subscribeBarcodeScanView,
  type BarcodeScanSnapshot,
} from "@/lib/capacitor/barcode-scan-session"
import styles from "./barcode-scanner-overlay.module.css"

function ActiveBarcodeScanView({ session }: { session: BarcodeScanSnapshot }) {
  const t = useTranslations("mobile.barcodeScanner")
  const previousFocus = useRef<HTMLElement | null>(null)
  useBackDismiss(true, session.cancel)

  useLayoutEffect(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const elements = [document.documentElement, document.body]
    const added = elements.filter((element) => !element.classList.contains(styles.nativePreview))
    for (const element of added) element.classList.add(styles.nativePreview)
    return () => {
      for (const element of added) element.classList.remove(styles.nativePreview)
    }
  }, [])

  return (
    <Dialog open onOpenChange={(open) => { if (!open) session.cancel() }}>
      <DialogPortal>
        <DialogPrimitive.Content
          className={styles.scan}
          onPointerDownOutside={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            if (previousFocus.current?.isConnected) previousFocus.current.focus()
          }}
        >
          <div className={styles.header}>
            <DialogTitle className="text-lg text-white">{t("title")}</DialogTitle>
            <Button variant="ghost" size="icon" className="size-12 text-white hover:bg-white/20 hover:text-white" aria-label={t("cancel")} onClick={session.cancel}>
              <X aria-hidden="true" />
            </Button>
          </div>
          <div className={styles.frame} aria-hidden="true" />
          <div className={styles.footer}>
            <DialogDescription className="text-center text-base text-white">{t("instruction")}</DialogDescription>
            {session.toggleTorch && (
              <Button variant="secondary" disabled={session.torchPending} aria-pressed={session.torchEnabled} onClick={session.toggleTorch}>
                {session.torchEnabled ? <FlashlightOff aria-hidden="true" /> : <Flashlight aria-hidden="true" />}
                {t(session.torchEnabled ? "torchOff" : "torchOn")}
              </Button>
            )}
            {session.torchError && <p role="status" className="text-center text-sm text-white">{t("torchError")}</p>}
          </div>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  )
}

/** One host serves every native scanning entry point, including remote steps. */
export function BarcodeScannerOverlay() {
  const session = useSyncExternalStore(subscribeBarcodeScanView, getBarcodeScanSnapshot, getBarcodeScanServerSnapshot)
  useEffect(registerBarcodeScanHost, [])
  return session ? <ActiveBarcodeScanView session={session} /> : null
}
