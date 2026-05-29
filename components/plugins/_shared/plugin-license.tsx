"use client"

// Shared license display: an SPDX badge (from `manifest.license`) plus an
// optional expandable showing the captured full LICENSE text. Reused by the
// marketplace detail sheet, the installed-plugin overview, and the GitHub
// install preview. Renders nothing when neither a license id nor text exists.

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"

interface Props {
  /** SPDX identifier from the manifest (e.g. "MIT"). */
  license?: string
  /** Raw LICENSE file text captured at install / preview time. */
  licenseText?: string | null
  className?: string
}

export function PluginLicense({ license, licenseText, className }: Props) {
  const t = useTranslations("plugins.license")
  const [open, setOpen] = useState(false)

  if (!license && !licenseText) return null

  return (
    <div className={className} data-testid="plugin-license">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">{t("label")}</span>
        {license ? (
          <Badge variant="outline" className="text-xs">
            {license}
          </Badge>
        ) : (
          <span className="text-xs">{t("custom")}</span>
        )}
        {licenseText && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
          >
            {open ? t("hide") : t("view")}
          </Button>
        )}
      </div>
      {open && licenseText && (
        <ScrollArea className="mt-2 max-h-60 rounded border">
          <pre className="p-3 text-xs leading-relaxed whitespace-pre-wrap font-mono">
            {licenseText}
          </pre>
        </ScrollArea>
      )}
    </div>
  )
}
