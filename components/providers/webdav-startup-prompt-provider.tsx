"use client"

// On startup, checks whether the WebDAV server holds a snapshot newer than
// this device's last backup and, if so, surfaces a non-blocking toast offering
// to restore. Restore itself is always explicit (opens the confirm dialog).

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { checkRemoteNewerThanLocal } from "@/lib/webdav/startup-check"
import { WebDavRestoreDialog } from "@/components/data/import/webdav-restore-dialog"

export function WebDavStartupPromptProvider({ children }: { children: React.ReactNode }) {
  const t = useTranslations("settings.data.webdav.startup")
  const ranRef = useRef(false)
  const [restoreOpen, setRestoreOpen] = useState(false)

  useEffect(() => {
    if (process.env.NODE_ENV === "test") return
    if (typeof window === "undefined") return
    if (ranRef.current) return
    ranRef.current = true

    void (async () => {
      try {
        const result = await checkRemoteNewerThanLocal()
        if (result?.newer) {
          toast.info(t("newerFound"), {
            duration: 12_000,
            action: { label: t("restoreAction"), onClick: () => setRestoreOpen(true) },
          })
        }
      } catch {
        // Never let a startup check disrupt boot.
      }
    })()
  }, [t])

  return (
    <>
      {children}
      <WebDavRestoreDialog open={restoreOpen} onOpenChange={setRestoreOpen} />
    </>
  )
}
