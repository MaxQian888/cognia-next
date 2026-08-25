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
      className="relative isolate overflow-hidden rounded-2xl border bg-card text-card-foreground shadow-sm"
      data-testid="about-hero"
    >
      {/* Ambient wash — two blurred primary orbs behind the identity block. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-24 -left-20 -z-10 size-64 rounded-full bg-primary/15 blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -right-24 -bottom-28 -z-10 size-72 rounded-full bg-primary/10 blur-3xl"
      />

      <div className="flex flex-col items-center gap-4 p-6 text-center sm:flex-row sm:items-center sm:gap-5 sm:p-7 sm:text-left">
        <Image
          src="/icons/icon-512.png"
          alt={t("iconAlt", { name })}
          width={72}
          height={72}
          className="size-16 shrink-0 rounded-2xl shadow-md ring-1 ring-border sm:size-[72px]"
          unoptimized
          priority
        />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center justify-center gap-2 sm:justify-start">
            <h2 className="min-w-0 truncate text-xl font-semibold tracking-tight sm:text-2xl">
              {name}
            </h2>
            <Badge variant={CHANNEL_VARIANT[channel]}>{t(`channel.${channel}`)}</Badge>
            {isWeb && (
              <Badge variant="outline" data-testid="about-web-badge">
                {t("webBadge")}
              </Badge>
            )}
          </div>
          <p className="text-sm text-pretty text-muted-foreground">{t("tagline")}</p>
          <div className="flex flex-wrap items-center justify-center gap-2 pt-0.5 sm:justify-start">
            <span className="inline-flex items-center gap-1.5 rounded-pill border bg-background/70 px-2.5 py-1 text-xs text-muted-foreground">
              <span aria-hidden className="size-1.5 rounded-full bg-primary" />
              {t("versionLine")}
              <span className="font-mono text-foreground">{APP_VERSION}</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
