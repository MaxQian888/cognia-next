"use client"

// Per-component surface customization. Lets the user tune each shadcn surface
// (Card, Dialog, Popover, …) on three axes — tonality (wallpaper translucency),
// elevation (shadow depth), and corner radius. Reads/writes
// `settings.componentStyles`; the `ComponentStyleApplier` turns the result into
// an injected stylesheet keyed off each component's `data-slot`.
//
// Every breakpoint here is `@…/appearance-pane`, not a viewport one: the rows
// render inside the section's detail pane, so the label column and the three
// axis selects have to size off that box rather than the window behind it.

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useSettingsStore } from "@/stores/settings"
import {
  COMPONENT_STYLE_GROUPS,
  COMPONENT_STYLE_REGISTRY,
} from "@/lib/appearance/component-style-registry"
import type {
  ComponentElevation,
  ComponentStyleKey,
  ComponentStyleOverride,
  ComponentStyles,
  ComponentTonality,
} from "@/types/appearance"

const INHERIT = "__inherit"

const TONALITY_OPTIONS: ComponentTonality[] = [
  "default",
  "solid",
  "translucent",
  "glass",
  "frosted",
]
const ELEVATION_OPTIONS: ComponentElevation[] = ["default", "0", "1", "2", "3"]
const RADIUS_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const

/** Box-shadow preview values — kept in sync with the applier's elevation map. */
const PREVIEW_SHADOW: Record<Exclude<ComponentElevation, "default">, string> = {
  "0": "none",
  "1": "0 1px 2px 0 oklch(0 0 0 / 0.08)",
  "2": "0 4px 12px -2px oklch(0 0 0 / 0.12), 0 2px 4px -2px oklch(0 0 0 / 0.08)",
  "3": "0 12px 32px -4px oklch(0 0 0 / 0.18), 0 4px 12px -4px oklch(0 0 0 / 0.1)",
}

function isCustomized(o: ComponentStyleOverride | undefined): boolean {
  if (!o) return false
  return (
    (!!o.tonality && o.tonality !== "default") ||
    (!!o.elevation && o.elevation !== "default") ||
    (typeof o.radiusScale === "number" && o.radiusScale !== 1)
  )
}

export function ComponentsTab() {
  const t = useTranslations("settings.appearance.componentCustomize")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const componentStyles: ComponentStyles = useMemo(
    () => settings?.componentStyles ?? {},
    [settings?.componentStyles]
  )

  const anyCustomized = COMPONENT_STYLE_REGISTRY.some((e) => isCustomized(componentStyles[e.key]))

  function patch(key: ComponentStyleKey, next: ComponentStyleOverride) {
    const merged: ComponentStyleOverride = { ...componentStyles[key], ...next }
    // Drop keys that are back to "inherit" so an empty override never lingers.
    if (merged.tonality === "default") delete merged.tonality
    if (merged.elevation === "default") delete merged.elevation
    if (merged.radiusScale === 1) delete merged.radiusScale
    const nextStyles: ComponentStyles = { ...componentStyles }
    if (Object.keys(merged).length === 0) {
      delete nextStyles[key]
    } else {
      nextStyles[key] = merged
    }
    void save({ componentStyles: nextStyles })
  }

  function resetAll() {
    void save({ componentStyles: {} })
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <p className="text-xs text-muted-foreground">{t("description")}</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!anyCustomized}
          onClick={resetAll}
        >
          {t("resetAll")}
        </Button>
      </div>

      {COMPONENT_STYLE_GROUPS.map((group) => {
        const entries = COMPONENT_STYLE_REGISTRY.filter((e) => e.group === group)
        return (
          <section key={group} className="space-y-3">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">
              {t(`groups.${group}`)}
            </Label>
            <div className="space-y-3">
              {entries.map((entry) => {
                const o = componentStyles[entry.key] ?? {}
                const tonality = o.tonality ?? "default"
                const elevation = o.elevation ?? "default"
                const radius = o.radiusScale ?? 1
                return (
                  <div
                    key={entry.key}
                    data-component-key={entry.key}
                    className="flex flex-col gap-3 rounded-lg border p-3 @2xl/appearance-pane:flex-row @2xl/appearance-pane:items-center"
                  >
                    {/* Live preview swatch — reflects elevation + radius directly. */}
                    <div className="flex items-center gap-3 @2xl/appearance-pane:w-40">
                      <div
                        aria-hidden
                        data-slot="component-preview"
                        className="flex size-10 shrink-0 items-center justify-center border bg-card text-[10px] text-muted-foreground"
                        style={{
                          borderRadius: `calc(var(--radius) * ${radius})`,
                          boxShadow:
                            elevation === "default" ? undefined : PREVIEW_SHADOW[elevation],
                        }}
                      >
                        Aa
                      </div>
                      <span className="text-sm font-medium">{t(`items.${entry.labelKey}`)}</span>
                    </div>

                    <div className="grid flex-1 grid-cols-1 gap-2 @sm/appearance-pane:grid-cols-3">
                      {/* Tonality */}
                      <div className="space-y-1">
                        <Label className="text-[11px] text-muted-foreground">
                          {t("axis.tonality")}
                        </Label>
                        <Select
                          value={tonality}
                          onValueChange={(v) =>
                            patch(entry.key, { tonality: v as ComponentTonality })
                          }
                        >
                          <SelectTrigger
                            aria-label={t("axis.tonalityFor", {
                              name: t(`items.${entry.labelKey}`),
                            })}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {TONALITY_OPTIONS.map((opt) => (
                              <SelectItem key={opt} value={opt}>
                                {t(`tonality.${opt}`)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      {/* Elevation */}
                      <div className="space-y-1">
                        <Label className="text-[11px] text-muted-foreground">
                          {t("axis.elevation")}
                        </Label>
                        <Select
                          value={elevation}
                          onValueChange={(v) =>
                            patch(entry.key, { elevation: v as ComponentElevation })
                          }
                        >
                          <SelectTrigger
                            aria-label={t("axis.elevationFor", {
                              name: t(`items.${entry.labelKey}`),
                            })}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {ELEVATION_OPTIONS.map((opt) => (
                              <SelectItem key={opt} value={opt}>
                                {opt === "default" ? t("elevation.default") : opt}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      {/* Radius */}
                      <div className="space-y-1">
                        <Label className="text-[11px] text-muted-foreground">
                          {t("axis.radius")}
                        </Label>
                        <Select
                          value={radius === 1 && !o.radiusScale ? INHERIT : String(radius)}
                          onValueChange={(v) =>
                            patch(entry.key, {
                              radiusScale: v === INHERIT ? 1 : Number(v),
                            })
                          }
                        >
                          <SelectTrigger
                            aria-label={t("axis.radiusFor", { name: t(`items.${entry.labelKey}`) })}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={INHERIT}>{t("radius.inherit")}</SelectItem>
                            {RADIUS_OPTIONS.map((opt) => (
                              <SelectItem key={opt} value={String(opt)}>
                                {opt}×
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
        )
      })}

      <p className="text-[11px] text-muted-foreground">{t("tonalityHint")}</p>
    </div>
  )
}
