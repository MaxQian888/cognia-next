"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { TagIcon } from "lucide-react"

import {
  APP_VERSION,
  getBuildInfo,
  getNativeBuildNumber,
  getRuntimeVersions,
  type RuntimeVersions,
} from "@/lib/app-metadata"

import { AboutCard } from "./about-card"
import { InfoRow } from "./info-row"

/**
 * One runtime-version chip. Chips live on a single wrapping strip so the card
 * body has a fixed shape — nothing here expands or collapses, which is what
 * keeps the About grid from reflowing while the user reads it.
 */
function RuntimeChip({ label, value, testid }: { label: string; value: string; testid: string }) {
  return (
    <span
      data-testid={testid}
      className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1 text-[11px] leading-none"
    >
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono text-foreground">{value}</span>
    </span>
  )
}

/** Format an ISO build timestamp for display; passthrough on parse failure. */
function formatBuildTime(iso: string): string {
  if (!iso) return ""
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

export interface VersionBuildCardProps {
  /** Test seam for the Capacitor native build loader. */
  nativeBuildLoader?: () => Promise<string | null>
}

/**
 * Version & build details: package version, native build number (Capacitor),
 * git commit + build time, and an expandable "advanced" block with runtime
 * versions (Tauri / React / web engine).
 */
export function VersionBuildCard({ nativeBuildLoader }: VersionBuildCardProps = {}) {
  const t = useTranslations("settings.about")
  const [nativeBuild, setNativeBuild] = useState<string | null>(null)
  const [runtime, setRuntime] = useState<RuntimeVersions | null>(null)
  const build = getBuildInfo()

  useEffect(() => {
    let cancelled = false
    void getNativeBuildNumber(nativeBuildLoader).then((b) => {
      if (!cancelled) setNativeBuild(b)
    })
    void getRuntimeVersions().then((r) => {
      if (!cancelled) setRuntime(r)
    })
    return () => {
      cancelled = true
    }
  }, [nativeBuildLoader])

  const buildTime = formatBuildTime(build.buildTime)

  return (
    <AboutCard icon={TagIcon} title={t("versionCard.title")} testid="about-version-card">
      <InfoRow label={t("versionCard.version")} value={APP_VERSION} mono testid="row-version" />
      {nativeBuild && (
        <InfoRow
          label={t("versionCard.build")}
          value={nativeBuild}
          mono
          testid="row-native-build"
        />
      )}
      {build.commit && (
        <InfoRow label={t("versionCard.commit")} value={build.commit} mono testid="row-commit" />
      )}
      {buildTime && (
        <InfoRow label={t("versionCard.builtAt")} value={buildTime} testid="row-build-time" />
      )}

      <div className="mt-3 flex items-center gap-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        {t("versionCard.runtime")}
        <span aria-hidden className="h-px flex-1 bg-border" />
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5" data-testid="runtime-versions">
        {runtime?.tauri && (
          <RuntimeChip label={t("versionCard.tauri")} value={runtime.tauri} testid="row-tauri" />
        )}
        <RuntimeChip
          label={t("versionCard.react")}
          value={runtime?.react ?? "—"}
          testid="row-react"
        />
        {runtime?.engine && (
          <RuntimeChip label={t("versionCard.engine")} value={runtime.engine} testid="row-engine" />
        )}
      </div>
    </AboutCard>
  )
}
