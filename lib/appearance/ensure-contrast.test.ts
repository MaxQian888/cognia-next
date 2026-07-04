import type { ThemeColors } from "@/types/plugin/plugin"
import { wcagContrast } from "./contrast"
import { AA_NORMAL_TEXT, ensureForegroundContrast } from "./ensure-contrast"

// A fully legible dark palette (mirrors the app's NEUTRAL_DARK preset). Every
// surface/foreground pair already clears AA, so the pass should be a no-op.
const READABLE: ThemeColors = {
  primary: "#60a5fa",
  primaryForeground: "#0b1220",
  secondary: "#94a3b8",
  secondaryForeground: "#0b1220",
  accent: "#60a5fa",
  accentForeground: "#0b1220",
  background: "#0b1220",
  foreground: "#f1f5f9",
  muted: "#1e293b",
  mutedForeground: "#94a3b8",
  card: "#0f172a",
  cardForeground: "#f1f5f9",
  popover: "#0f172a",
  popoverForeground: "#f1f5f9",
  input: "#1e293b",
  border: "#1e293b",
  ring: "#60a5fa",
  destructive: "#f87171",
  destructiveForeground: "#0b1220",
  sidebar: "#0f172a",
  sidebarForeground: "#f1f5f9",
  sidebarPrimary: "#60a5fa",
  sidebarBorder: "#1e293b",
  sidebarPrimaryForeground: "#0b1220",
  sidebarAccent: "#1e293b",
  sidebarAccentForeground: "#f1f5f9",
  sidebarRing: "#60a5fa",
}

it("returns the same object when every pair already passes AA", () => {
  expect(ensureForegroundContrast(READABLE)).toBe(READABLE)
})

it("corrects a clashing secondary foreground until it passes AA", () => {
  const clashing: ThemeColors = {
    ...READABLE,
    secondary: "#444444",
    secondaryForeground: "#3d3d3d", // near-identical → invisible label
  }
  expect(wcagContrast(clashing.secondaryForeground, clashing.secondary)).toBeLessThan(
    AA_NORMAL_TEXT
  )

  const fixed = ensureForegroundContrast(clashing)

  expect(fixed).not.toBe(clashing)
  expect(fixed.secondaryForeground).not.toBe(clashing.secondaryForeground)
  expect(wcagContrast(fixed.secondaryForeground, fixed.secondary)).toBeGreaterThanOrEqual(
    AA_NORMAL_TEXT
  )
})

it("leaves the surface and unrelated foregrounds untouched", () => {
  const clashing: ThemeColors = {
    ...READABLE,
    secondary: "#444444",
    secondaryForeground: "#3d3d3d",
  }
  const fixed = ensureForegroundContrast(clashing)

  // Surface is never moved — only the text color is.
  expect(fixed.secondary).toBe("#444444")
  // Other already-legible foregrounds are preserved verbatim.
  expect(fixed.primaryForeground).toBe(READABLE.primaryForeground)
  expect(fixed.foreground).toBe(READABLE.foreground)
  // Non-text tokens are not in the pair table at all.
  expect(fixed.border).toBe(READABLE.border)
  expect(fixed.ring).toBe(READABLE.ring)
})

it("honors a custom target ratio", () => {
  // A dark surface can reach AAA (7:1) with a light foreground, so the clashing
  // dark-on-dark pair is pushed lighter until it clears 7:1.
  const pair: ThemeColors = {
    ...READABLE,
    primary: "#222222",
    primaryForeground: "#2a2a2a",
  }
  const fixed = ensureForegroundContrast(pair, 7) // AAA normal text
  expect(wcagContrast(fixed.primaryForeground, fixed.primary)).toBeGreaterThanOrEqual(7)
})
