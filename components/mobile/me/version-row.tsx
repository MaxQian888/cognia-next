"use client"

/**
 * Version display row for the About section. Reads `APP_VERSION` from
 * the existing `lib/app-version.ts` (universal) and, when running inside
 * Capacitor, appends the native build number via `@capacitor/app`.
 *
 * Falls back gracefully on web / Tauri — the native build call rejects
 * and we render just the package version.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { InfoIcon } from "lucide-react"

import { MeRow } from "./me-row"
import { APP_VERSION } from "@/lib/app-version"

interface CapacitorAppShape {
  getInfo(): Promise<{ name: string; version: string; build: string; id: string }>
}

async function loadNativeBuild(): Promise<string | null> {
  try {
    const moduleId = "@capacitor/app"
    const mod = (await import(/* webpackIgnore: true */ moduleId)) as {
      App: CapacitorAppShape
    }
    const info = await mod.App.getInfo()
    return info.build
  } catch {
    return null
  }
}

export interface VersionRowProps {
  /** Override the loader — primarily for tests. */
  loader?: () => Promise<string | null>
}

export function VersionRow({ loader }: VersionRowProps = {}) {
  const t = useTranslations("mobile.me.about")
  const [nativeBuild, setNativeBuild] = useState<string | null>(null)

  useEffect(() => {
    const fn = loader ?? loadNativeBuild
    let cancelled = false
    fn()
      .then((build) => {
        if (cancelled) return
        setNativeBuild(build)
      })
      .catch(() => {
        // Loader rejection means we can't read a native build number —
        // fall back to APP_VERSION-only by leaving `nativeBuild` null.
      })
    return () => {
      cancelled = true
    }
  }, [loader])

  const value = nativeBuild ? `${APP_VERSION} (${nativeBuild})` : APP_VERSION

  return <MeRow icon={InfoIcon} label={t("versionLabel")} value={value} testid="me-version-row" />
}
