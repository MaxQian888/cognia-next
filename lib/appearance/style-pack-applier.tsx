"use client"

import { useEffect } from "react"
import { useSettingsStore } from "@/stores/settings"
import { resolveStylePack, type StylePackSettings } from "@/types/appearance/style-pack"
import { applyDataAttrs } from "./css-var"

/** Custom properties this applier owns on `<html>`. */
const STYLE_PACK_VARS = ["--pill-radius", "--style-letter-spacing-em"] as const

/** Data attributes this applier owns on `<html>`. */
const STYLE_PACK_ATTRS = [
  "data-style-pack",
  "data-border-tone",
  "data-elevation-max",
  "data-micro-label",
] as const

export interface StylePackDom {
  vars: Record<string, string | null>
  attrs: Record<string, string | null>
}

/**
 * Project a style-pack setting into the exact DOM writes it implies.
 *
 * Every field returns `null` at its default so the caller removes the
 * declaration and the `:root` stylesheet stays the source of truth. That is
 * what makes "the Soft pack changes nothing" structural rather than a promise:
 * with `soft` selected (or a customised pack whose values happen to match it)
 * this returns all-nulls and the applier writes literally nothing to the DOM.
 * Same guarantee `RadiusApplier` and the `classic` composer skin already give.
 *
 * Pure — exported for tests.
 */
export function resolveStylePackDom(settings: StylePackSettings | undefined): StylePackDom {
  const pack = resolveStylePack(settings)
  if (pack.isDefault) {
    return {
      vars: { "--pill-radius": null, "--style-letter-spacing-em": null },
      attrs: {
        "data-style-pack": null,
        "data-border-tone": null,
        "data-elevation-max": null,
        "data-micro-label": null,
      },
    }
  }
  return {
    vars: {
      // 9999px is the stylesheet default; only a pack that squares (or shrinks)
      // pills needs to say so.
      "--pill-radius": pack.pillRadiusPx === 9999 ? null : `${pack.pillRadiusPx}px`,
      "--style-letter-spacing-em": pack.letterSpacingEm === 0 ? null : `${pack.letterSpacingEm}em`,
    },
    attrs: {
      // Written even when a customised pack resolves to soft-ish values, so the
      // UI (and a support report) can always read back which pack is active.
      "data-style-pack": pack.packId,
      "data-border-tone": pack.borderTone === "default" ? null : pack.borderTone,
      "data-elevation-max": pack.elevationMax === 3 ? null : String(pack.elevationMax),
      "data-micro-label": pack.microLabel === "default" ? null : pack.microLabel,
    },
  }
}

/**
 * Mounts at the root layout. Reflects the active style pack onto `<html>` as a
 * handful of data attributes plus two custom properties; the matching CSS lives
 * in the "Style packs" section of `globals.css`.
 *
 * Deliberately *not* the writer for `--radius` or `data-density` — those are
 * owned by `RadiusApplier` and `DensityApplier`, which each read the pack as
 * their base value. Two appliers writing the same inline property would race,
 * and the loser would silently erase the winner on every settings change.
 */
export function StylePackApplier(): null {
  const stylePack = useSettingsStore((s) => s.settings?.stylePack)

  useEffect(() => {
    if (typeof document === "undefined") return
    const root = document.documentElement
    const { vars, attrs } = resolveStylePackDom(stylePack)

    for (const name of STYLE_PACK_VARS) {
      const value = vars[name]
      if (value) root.style.setProperty(name, value)
      else root.style.removeProperty(name)
    }
    applyDataAttrs(root, attrs)

    return () => {
      for (const name of STYLE_PACK_VARS) root.style.removeProperty(name)
      for (const name of STYLE_PACK_ATTRS) root.removeAttribute(name)
    }
  }, [stylePack])

  return null
}
