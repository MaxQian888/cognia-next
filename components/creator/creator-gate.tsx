"use client"

/**
 * Developer-mode gate for the Creator workbench (ADR-0117).
 *
 * The route itself stays in the static export — `output: "export"` means every
 * route is prerendered at build time, so "hide the page" is not something a
 * build flag can do. What the gate does is refuse to render the workbench, and
 * it reads the same single source of truth (`pluginSettings.developerModeEnabled`)
 * that decides whether the Creator chat preset is offered, so the two can never
 * disagree about whether Creator exists.
 */

import { useTranslations } from "next-intl"
import { Wand2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { setDeveloperModeEnabled, useDeveloperMode } from "@/lib/plugin/devtools/developer-mode"

export function CreatorGate({ children }: { children: React.ReactNode }) {
  const t = useTranslations("creator.gate")
  const enabled = useDeveloperMode()

  if (enabled) return <>{children}</>

  return (
    <div className="flex h-full min-h-0 flex-1 items-center justify-center p-8">
      <div className="max-w-md space-y-3 text-center">
        <Wand2 className="mx-auto size-8 text-muted-foreground" aria-hidden />
        <h1 className="text-lg font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
        <Button onClick={() => setDeveloperModeEnabled(true)}>{t("enable")}</Button>
      </div>
    </div>
  )
}

export default CreatorGate
