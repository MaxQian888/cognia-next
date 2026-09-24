// Temporary audit of built-in theme palettes against app-surface semantics.
import { converter, parse } from "culori"
import { wcagContrast } from "../lib/appearance/contrast"
import { BUILT_IN_DESIGNED_THEMES } from "../lib/themes/built-in-themes"
import { BUILT_IN_VSCODE_THEMES } from "../lib/appearance/built-in-vscode-themes"
import type { ThemeColors } from "../types/plugin/plugin"

const toOklch = converter("oklch")

function oklch(hex: string): { l: number; c: number; h: number } {
  const p = toOklch(parse(hex) as never)
  return { l: p?.l ?? 0, c: p?.c ?? 0, h: p?.h ?? 0 }
}

function cr(a: string, b: string): number {
  try {
    return wcagContrast(a, b)
  } catch {
    return NaN
  }
}

function audit(name: string, variant: "light" | "dark", p: ThemeColors) {
  const acc = oklch(p.accent)
  const fgBg = cr(p.foreground, p.background)
  const mutFgBg = cr(p.mutedForeground, p.background)
  const mutFgMuted = cr(p.mutedForeground, p.muted)
  const cardL = oklch(p.card).l
  const bgL = oklch(p.background).l
  const popL = oklch(p.popover).l
  const inputCard = cr(p.input, p.card)
  const borderCard = cr(p.border, p.card)
  const secFg = cr(p.secondaryForeground, p.secondary)
  const accFg = cr(p.accentForeground, p.accent)
  const sidebarBg = oklch(p.sidebar).l
  const flags: string[] = []
  if (acc.c > 0.08) flags.push(`accent saturated (c=${acc.c.toFixed(2)})`)
  const mutRatio = mutFgBg / fgBg
  if (mutRatio > 0.75) flags.push(`mutedFg≈fg (mut ${mutFgBg.toFixed(1)} vs fg ${fgBg.toFixed(1)})`)
  if (mutFgMuted < 4.5) flags.push(`mutedFg/muted ${mutFgMuted.toFixed(1)}<4.5`)
  if (variant === "dark" && cardL < bgL - 0.005) flags.push(`card darker than bg`)
  if (variant === "dark" && popL < bgL - 0.005) flags.push(`popover darker than bg`)
  if (variant === "light" && cardL < bgL - 0.02) flags.push(`card darker than bg`)
  if (inputCard < 1.15) flags.push(`input≈card (${inputCard.toFixed(2)})`)
  if (borderCard < 1.05) flags.push(`border invisible on card`)
  if (secFg < 4.5) flags.push(`secondaryFg ${secFg.toFixed(1)}<4.5`)
  if (accFg < 3.0) flags.push(`accentFg ${accFg.toFixed(1)}<3.0`)
  console.log(
    `${name.padEnd(22)} ${variant.padEnd(5)} | bgL ${bgL.toFixed(2)} cardL ${cardL.toFixed(2)} sbL ${sidebarBg.toFixed(2)} | ` +
      `accL/C ${acc.l.toFixed(2)}/${acc.c.toFixed(2)} | fg ${fgBg.toFixed(1)} mut ${mutFgBg.toFixed(1)} | ` +
      (flags.length ? flags.join("; ") : "ok")
  )
}

console.log("=== DESIGNED ===")
for (const t of BUILT_IN_DESIGNED_THEMES) {
  audit(t.name, "light", t.tokens!.light)
  audit(t.name, "dark", t.tokens!.dark)
}
console.log("=== VSCODE ===")
for (const t of BUILT_IN_VSCODE_THEMES) {
  audit(t.name, "light", t.tokens!.light)
  audit(t.name, "dark", t.tokens!.dark)
}
