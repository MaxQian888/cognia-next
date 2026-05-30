"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronsUpDownIcon, TagIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Separator } from "@/components/ui/separator"
import {
  APP_VERSION,
  getBuildInfo,
  getNativeBuildNumber,
  getRuntimeVersions,
  type RuntimeVersions,
} from "@/lib/app-metadata"

import { InfoRow } from "./info-row"

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
  const [open, setOpen] = useState(false)
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
    <Card data-testid="about-version-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <TagIcon className="size-4" />
          {t("versionCard.title")}
        </CardTitle>
      </CardHeader>
      <CardContent>
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

        <Collapsible open={open} onOpenChange={setOpen} className="mt-2">
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="-ml-2 h-8" data-testid="advanced-toggle">
              <ChevronsUpDownIcon className="mr-2 size-4" />
              {open ? t("versionCard.hideAdvanced") : t("versionCard.showAdvanced")}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <Separator className="my-2" />
            {runtime?.tauri && (
              <InfoRow
                label={t("versionCard.tauri")}
                value={runtime.tauri}
                mono
                testid="row-tauri"
              />
            )}
            <InfoRow
              label={t("versionCard.react")}
              value={runtime?.react ?? "—"}
              mono
              testid="row-react"
            />
            {runtime?.engine && (
              <InfoRow
                label={t("versionCard.engine")}
                value={runtime.engine}
                mono
                testid="row-engine"
              />
            )}
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  )
}
