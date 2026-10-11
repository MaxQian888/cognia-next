"use client"

/**
 * One capability chip on a plugin row or card, with the concrete
 * contributions behind it (e.g. `tools · 3` lists the three tool ids).
 *
 * The Library row and the card grid each carried an identical copy of this,
 * both as a hover-only HoverCard on a `tabIndex={0}` span: a phone could never
 * open it, and the two copies had already drifted apart in how they printed a
 * label. It is one component now, disclosed through `PluginHint` (tooltip on
 * hover, popover on tap, a real button for the keyboard). With no mapped
 * contribution surface it stays a plain, non-interactive badge.
 *
 * The chip prints the capability's NAME (`capabilityLabel`), not its id, so a
 * Chinese UI reads "主题包 · 5" rather than "theme-pack · 5". The id stays in
 * the disclosure, next to the entries it groups.
 */

import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

import { PluginHint } from "./plugin-hint"
import { capabilityLabel } from "../plugin-capabilities"

export interface PluginContributionChipProps {
  capability: string
  count: number
  entries: ReadonlyArray<{ id: string; label?: string }>
  /** Classes for the chip (or its hint trigger when it has entries). */
  className?: string
}

export function PluginContributionChip({
  capability,
  count,
  entries,
  className,
}: PluginContributionChipProps) {
  const t = useTranslations("plugins.card")
  const tCapability = useTranslations("plugins.categorySidebar")
  const { label: name, known } = capabilityLabel(tCapability as never, capability)
  const label = count > 0 ? t("capabilityChipLabel", { name, count }) : name

  if (entries.length === 0) {
    return (
      <Badge
        variant="outline"
        className={cn("shrink-0 text-xs", !known && "font-mono", className)}
        title={capability}
      >
        {label}
      </Badge>
    )
  }

  return (
    <PluginHint
      label={t("capabilityChipAria", { capability: name, count })}
      side="bottom"
      align="start"
      className={className}
      contentClassName="w-72"
      content={
        <div className="space-y-2">
          <div className="flex items-baseline gap-1.5 text-xs font-semibold">
            {label}
            {known ? (
              <code className="font-mono text-[10px] font-normal text-muted-foreground">
                {capability}
              </code>
            ) : null}
          </div>
          <ul className="space-y-0.5 text-xs">
            {entries.map((entry) => (
              <li key={entry.id} className="flex min-w-0 items-baseline gap-1.5">
                <code className="break-all font-mono text-[10px] text-muted-foreground">
                  {entry.id}
                </code>
                {entry.label && entry.label !== entry.id && (
                  <span className="text-muted-foreground">{entry.label}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      }
    >
      <Badge
        variant="outline"
        className={cn("shrink-0 cursor-help text-xs", !known && "font-mono")}
      >
        {label}
      </Badge>
    </PluginHint>
  )
}
