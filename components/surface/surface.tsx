import * as React from "react"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

/**
 * Which tier of the interface a surface belongs to (ADR-0148).
 *
 * Translucency used to be configured per component — 28 `data-slot` entries in
 * `component-style-registry.ts`, each picking its own tonality — which is why
 * neighbouring panels sat at visibly different opacities over a wallpaper, and
 * why every bespoke surface (page shells, rails, feature cards) was simply
 * invisible to the system and stayed fully opaque. Declaring a tier instead of
 * a value makes consistency structural: two panels on the same tier cannot
 * disagree.
 *
 *  - `base`    — the page ground a route paints on
 *  - `raised`  — cards and panels sitting on that ground
 *  - `overlay` — popovers, menus, dialogs, sheets floating above everything
 */
export type SurfaceLayer = "base" | "raised" | "overlay"

/**
 * Named radius steps. `control` / `panel` / `stage` are the scale
 * `web/app/globals.css` pins for the marketing site (8 / 12 / 14px at the
 * default base); `pill` follows its own axis so squaring the UI never squares a
 * status dot. `inherit` leaves radius to the caller's own class.
 */
export type SurfaceRadius = "control" | "panel" | "stage" | "pill" | "none" | "inherit"

/** Mirrors the `[data-elevation]` scale already defined in globals.css. */
export type SurfaceElevation = 0 | 1 | 2 | 3

const RADIUS_CLASS: Record<SurfaceRadius, string> = {
  control: "rounded-control",
  panel: "rounded-panel",
  stage: "rounded-stage",
  pill: "rounded-pill",
  none: "rounded-none",
  inherit: "",
}

export interface SurfaceProps extends React.ComponentProps<"div"> {
  layer?: SurfaceLayer
  radius?: SurfaceRadius
  /**
   * Drop-shadow depth. Omitted means "no opinion" — the caller's own
   * `shadow-*` class (if any) still applies, which is what lets existing
   * primitives adopt Surface without their default look shifting.
   */
  elevation?: SurfaceElevation
  /** Render into the child element instead of a `div` (Radix `Slot`). */
  asChild?: boolean
}

/**
 * The shared carrier for every panel-like container.
 *
 * The background is read from `--surface-bg` rather than hardcoded as
 * `bg-card`. That indirection is the whole point: the wallpaper layer can
 * retune a tier by redefining two custom properties, instead of the ~830
 * unlayered lines of `[data-slot]` overrides it needs today to beat each
 * component's own background utility. Setting a custom property never fights a
 * Tailwind utility for specificity, so nothing here has to leave `@layer`.
 *
 * Backdrop blur is deliberately NOT a class on this element. `backdrop-filter`
 * promotes a compositing layer even at `blur(0px)`, and these containers appear
 * inside the virtualized chat list; globals.css applies it only while a
 * wallpaper is actually enabled.
 *
 * Foreground colour is deliberately left to the caller. A tier implies one, but
 * owning it here would mean `text-[var(--surface-fg)]` competing with an
 * explicit `text-destructive` on the same element — and Tailwind sorts
 * arbitrary values after named ones, so the tier would quietly win and repaint
 * destructive copy.
 */
export function Surface({
  layer = "raised",
  radius = "inherit",
  elevation,
  asChild = false,
  className,
  ...props
}: SurfaceProps) {
  const Comp = asChild ? Slot.Root : "div"
  return (
    <Comp
      data-surface-layer={layer}
      data-elevation={elevation === undefined ? undefined : String(elevation)}
      className={cn("bg-[var(--surface-bg)]", RADIUS_CLASS[radius], className)}
      {...props}
    />
  )
}
