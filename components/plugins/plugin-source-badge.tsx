"use client"

// Where a plugin came from. Every `PluginSource` member has a label, so a
// dev or git build is named rather than rendered as its raw enum value.
//
// It also says when this build is shadowing an installed one. A dev build
// silently replacing the marketplace copy is the failure mode Zed and Slack
// both design against: the developer forgets, then debugs the wrong code.

import { useTranslations } from "next-intl"
import { PackageIcon, WrenchIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { PluginSource } from "@/types/plugin"

/** Every member of `PluginSource`, pinned so a new one cannot ship unlabelled. */
export const PLUGIN_SOURCES: PluginSource[] = ["builtin", "local", "marketplace", "git", "dev"]

/**
 * Narrow a stored value to a known source. `PluginRow.source` is a loose
 * `string` straight out of Dexie, and handing an unknown one to `t()` renders
 * the key. Returning null lets the caller show the raw value honestly instead.
 */
export function parsePluginSource(value: string): PluginSource | null {
  return (PLUGIN_SOURCES as string[]).includes(value) ? (value as PluginSource) : null
}

/** Sources that mean "not a released build". */
const DEVELOPMENT_SOURCES: ReadonlySet<PluginSource> = new Set(["dev", "local"])

export function isDevelopmentSource(source: PluginSource): boolean {
  return DEVELOPMENT_SOURCES.has(source)
}

/**
 * The sources this build is standing in front of. Pure.
 *
 * `observedSources` records every origin the same canonical plugin has been
 * seen at, so anything in it other than the active one is being shadowed.
 */
export function shadowedSources(
  source: PluginSource,
  observedSources: readonly PluginSource[] = []
): PluginSource[] {
  return [...new Set(observedSources)].filter((observed) => observed !== source)
}

interface Props {
  /** A `PluginSource`, or any stored string. Unknown values render as-is. */
  source: PluginSource | string
  /** Every origin this canonical plugin has been observed at. */
  observedSources?: readonly PluginSource[]
  className?: string
}

export function PluginSourceBadge({ source, observedSources, className }: Props) {
  const t = useTranslations("plugins.source")
  const known = typeof source === "string" ? parsePluginSource(source) : source
  const shadowed = known ? shadowedSources(known, observedSources) : []
  const development = known ? isDevelopmentSource(known) : false
  const label = known ? t(known as never) : source
  const title =
    shadowed.length > 0
      ? t("shadowing", { sources: shadowed.map((s) => t(s as never)).join(", ") })
      : undefined

  return (
    <Badge
      variant={development ? "default" : "secondary"}
      className={cn(className)}
      title={title}
      data-testid={`plugin-source-badge-${source}`}
      data-known={known ? undefined : "false"}
      data-shadowing={shadowed.length > 0 ? shadowed.join(",") : undefined}
    >
      {development ? (
        <WrenchIcon className="size-3" aria-hidden="true" />
      ) : (
        <PackageIcon className="size-3" aria-hidden="true" />
      )}
      <span className="ml-1 text-xs">{label}</span>
    </Badge>
  )
}
