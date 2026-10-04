"use client"

import Link from "next/link"
import { useTranslations } from "next-intl"

/** A desktop window URL remains navigable without importing its IPC runtime. */
export function DesktopWindowMessage() {
  const t = useTranslations("common")
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-base font-medium">{t("desktopOnly")}</h1>
      <Link href="/" className="text-sm underline underline-offset-4">
        {t("backToApp")}
      </Link>
    </main>
  )
}
