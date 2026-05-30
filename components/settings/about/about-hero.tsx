"use client"

import Image from "next/image"
import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { APP_NAME, APP_VERSION, getAppName, getReleaseChannel } from "@/lib/app-metadata"
import type { ReleaseChannel } from "@/lib/app-metadata"
import { isCapacitor, isTauri } from "@/lib/tauri"

const CHANNEL_VARIANT: Record<ReleaseChannel, "secondary" | "warning" | "outline"> = {
  stable: "secondary",
  rc: "warning",
  beta: "warning",
  alpha: "warning",
  dev: "outline",
}

/**
 * Branded hero header for the About page: app icon, name, release-channel
 * badge, tagline, and version. Mirrors the identity blocks of VS Code /
 * Raycast about screens.
 */
export function AboutHero() {
  const t = useTranslations("settings.about")
  const [name, setName] = useState(APP_NAME)
  const channel = getReleaseChannel()
  const isWeb = !isTauri() && !isCapacitor()

  useEffect(() => {
    let cancelled = false
    void getAppName().then((n) => {
      if (!cancelled) setName(n)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div
      className="flex items-center gap-4 rounded-xl border bg-card p-5 text-card-foreground shadow-sm"
      data-testid="about-hero"
    >
      <Image
        src="/icons/icon-512.png"
        alt={t("iconAlt", { name })}
        width={56}
        height={56}
        className="size-14 rounded-2xl shadow-sm"
        unoptimized
        priority
      />
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="truncate text-lg font-semibold">{name}</h2>
          <Badge variant={CHANNEL_VARIANT[channel]}>{t(`channel.${channel}`)}</Badge>
          {isWeb && (
            <Badge variant="outline" data-testid="about-web-badge">
              {t("webBadge")}
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground">{t("tagline")}</p>
        <p className="text-xs text-muted-foreground">
          {t("versionLine")} <span className="font-mono">{APP_VERSION}</span>
        </p>
      </div>
    </div>
  )
}
