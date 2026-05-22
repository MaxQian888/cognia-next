"use client"

/**
 * Settings page section for the integrated terminal dock. Loaded
 * lazily by `settings-shell.tsx` via the existing `dynamic(... ssr:false)`
 * pattern, so the heavy xterm modules never block the initial bundle.
 */

import { useTranslations } from "next-intl"

import { TerminalCard } from "./terminal-card"

export function TerminalSection() {
  const t = useTranslations("settings.terminal")

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h2 className="text-sm font-semibold">{t("heading")}</h2>
        <p className="text-xs text-muted-foreground">{t("subheading")}</p>
      </header>
      <TerminalCard />
    </div>
  )
}

export default TerminalSection
