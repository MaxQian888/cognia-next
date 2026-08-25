"use client"

// The style-pack chooser, shared by Settings → Appearance → Style and the
// custom onboarding path (ADR-0148). Extracted rather than duplicated: this
// whole effort exists because the same visual idea was implemented three times
// in three places, and a second divergent picker would be the same mistake.

import { useTranslations } from "next-intl"
import { CheckIcon } from "lucide-react"

import { useSettingsStore } from "@/stores/settings"
import {
  DEFAULT_STYLE_PACK,
  STYLE_PACKS,
  STYLE_PACK_IDS,
  resolveStylePack,
  type StylePackId,
} from "@/types/appearance/style-pack"
import { cn } from "@/lib/utils"
import { Surface } from "./surface"

/**
 * Render a pack's geometry locally so the choice is legible before it is made.
 * Scopes the same custom properties `StylePackApplier` writes onto `<html>`,
 * which also proves the pack really is expressible as those two variables.
 */
function PackPreview({ packId }: { packId: StylePackId }) {
  const pack = STYLE_PACKS[packId]
  return (
    <Surface
      aria-hidden
      layer="base"
      radius="panel"
      className="pointer-events-none flex flex-col gap-1.5 border p-2"
      style={
        {
          "--radius": `${pack.radiusBaseRem}rem`,
          "--pill-radius": `${pack.pillRadiusPx}px`,
        } as React.CSSProperties
      }
    >
      <Surface
        layer="raised"
        radius="panel"
        className="flex items-center gap-1.5 border p-1.5"
        style={{ boxShadow: pack.elevationMax === 0 ? "none" : undefined }}
      >
        <span className="h-2 w-6 shrink-0 rounded-pill bg-primary/40" />
        <span className="h-1.5 flex-1 rounded-control bg-muted-foreground/20" />
      </Surface>
      <div className="flex gap-1.5">
        <span className="h-3 flex-1 rounded-control bg-primary/70" />
        <span className="h-3 w-6 rounded-control border" />
      </div>
    </Surface>
  )
}

export interface StylePackPickerProps {
  /** Hide the per-pack description — onboarding has less room than settings. */
  compact?: boolean
  className?: string
}

export function StylePackPicker({ compact = false, className }: StylePackPickerProps) {
  const t = useTranslations("settings.appearance.stylePack")
  const stylePack = useSettingsStore((s) => s.settings?.stylePack) ?? DEFAULT_STYLE_PACK
  const save = useSettingsStore((s) => s.save)
  const activeId = resolveStylePack(stylePack).packId

  return (
    <div className={cn("grid gap-2 sm:grid-cols-3", className)}>
      {STYLE_PACK_IDS.map((id) => {
        const active = activeId === id
        return (
          <button
            key={id}
            type="button"
            aria-pressed={active}
            data-testid={`style-pack-${id}`}
            onClick={() => void save({ stylePack: { ...stylePack, packId: id } })}
            className={cn(
              "group flex flex-col gap-2 rounded-panel border p-2.5 text-left transition-colors",
              active
                ? "border-primary bg-primary/5"
                : "border-border hover:border-border hover:bg-accent/40"
            )}
          >
            <PackPreview packId={id} />
            <div className="flex items-center justify-between gap-1">
              <span className="text-xs font-medium">{t(`packs.${id}.name`)}</span>
              {active ? <CheckIcon className="size-3.5 shrink-0 text-primary" /> : null}
            </div>
            {compact ? null : (
              <span className="text-[11px] leading-snug text-muted-foreground">
                {t(`packs.${id}.description`)}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
