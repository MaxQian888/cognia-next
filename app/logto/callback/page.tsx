"use client"

import { useEffect } from "react"
import { useTranslations } from "next-intl"
import { readValidatedLogtoCallback } from "@/lib/logto/web-popup"

export default function LogtoCallbackPage() {
  const t = useTranslations("plugins.auth.callback")

  useEffect(() => {
    const payload = readValidatedLogtoCallback(window.location.search)
    window.opener?.postMessage(payload, window.location.origin)
    if (!payload.error) window.close()
  }, [])

  return (
    <main className="flex h-screen items-center justify-center p-6 text-center">
      <p className="text-sm text-muted-foreground">{t("done")}</p>
    </main>
  )
}
