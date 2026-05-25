"use client"

// Decorator badge marking a marketplace entry's origin. Surfaced in the
// Discover marketplace for built-in plugins — they ship with the app and
// can't be installed / uninstalled, so the badge stands in for the install
// CTA. Kept source-generic so other origins (local / marketplace) can reuse it.

import { useTranslations } from "next-intl"
import { PackageIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import type { PluginSource } from "@/types/plugin"

interface Props {
  source: PluginSource
  className?: string
}

export function PluginSourceBadge({ source, className }: Props) {
  const t = useTranslations("plugins.source")
  return (
    <Badge variant="secondary" className={className} data-testid={`plugin-source-badge-${source}`}>
      <PackageIcon className="size-3" />
      <span className="ml-1 text-xs">{t(source as never)}</span>
    </Badge>
  )
}
