// Platform-aware tray-icon rasterizer with status and usage badges.
//
// We reuse four Lucide icons verbatim by inlining their SVG path data
// (license: ISC, see `node_modules/lucide-react/LICENSE`). Inlining sidesteps
// Jest's ESM transform for the per-icon lucide-react entrypoints — the
// production code imports via Next's bundler which handles ESM fine, but
// Jest needs CommonJS-compatible source, and Lucide's CJS bundle does not
// expose `__iconNode` per icon. The data below mirrors lucide-react v1.14.0
// EXACTLY; if you want to upgrade the visual, copy the new `d` strings from
// `node_modules/lucide-react/dist/esm/icons/<name>.mjs`.
//
// Pipeline: `platform glyph + badges → offscreen canvas → PNG bytes →
// invoke("tray_register_icon")`. Rust caches the bytes keyed by state and
// `tray_set_icon_state` swaps them without any further IPC round-trip.

"use client"

import { invoke } from "@tauri-apps/api/core"

import { isTauri } from "@/lib/tauri"
import { isMacOs } from "@/lib/platform/os"
import { loggers } from "@cognia/logging"
import type { TrayIconState } from "./types"
import characterIcon from "@/src-tauri/icons/128x128.png"

/** One node in a Lucide iconNode: `[tagName, attrsByName]`. */
type LucideNode = [string, Record<string, string | number>]

/**
 * Per-state iconNode arrays, copied verbatim from lucide-react v1.14.0.
 * Mapping:
 *   idle  → MessageSquare
 *   busy  → LoaderCircle
 *   error → TriangleAlert (a.k.a. AlertTriangle in older exports)
 *   muted → BellOff
 */
const STATE_NODES: Record<TrayIconState, LucideNode[]> = {
  idle: [
    [
      "path",
      {
        d: "M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z",
      },
    ],
  ],
  busy: [["path", { d: "M21 12a9 9 0 1 1-6.219-8.56" }]],
  error: [
    [
      "path",
      {
        d: "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3",
      },
    ],
    ["path", { d: "M12 9v4" }],
    ["path", { d: "M12 17h.01" }],
  ],
  muted: [
    ["path", { d: "M10.268 21a2 2 0 0 0 3.464 0" }],
    [
      "path",
      {
        d: "M17 17H4a1 1 0 0 1-.74-1.673C4.59 13.956 6 12.499 6 8a6 6 0 0 1 .258-1.742",
      },
    ],
    ["path", { d: "m2 2 20 20" }],
    ["path", { d: "M8.668 3.01A6 6 0 0 1 18 8c0 2.687.77 4.653 1.707 6.05" }],
  ],
}

// A filled orbital C gives the menu bar a stable Cognia identity at 18 pt.
// Only the detail in its opening changes with state; the silhouette stays put.
const COGNIA_ORBIT_PATH = "M18.2 5.4a9 9 0 1 0 0 13.2l-2.4-2.4a5.7 5.7 0 1 1 0-8.4Z"

const MACOS_STATE_NODES: Record<TrayIconState, LucideNode[]> = {
  idle: [
    [
      "path",
      {
        d: "M19.2 8.3c.55 2.35 1.35 3.15 3.7 3.7-2.35.55-3.15 1.35-3.7 3.7-.55-2.35-1.35-3.15-3.7-3.7 2.35-.55 3.15-1.35 3.7-3.7Z",
        fill: "#000000",
        stroke: "none",
      },
    ],
  ],
  busy: [["path", { d: "M19.2 8.9a3.1 3.1 0 1 1-2.685 1.55", strokeWidth: 2 }]],
  error: [
    ["path", { d: "M19.2 8.7v3.9", strokeWidth: 2.2 }],
    ["circle", { cx: 19.2, cy: 15, r: 1.1, fill: "#000000", stroke: "none" }],
  ],
  muted: [["path", { d: "m16.6 9.4 5.2 5.2", strokeWidth: 2.2 }]],
}

/** Native macOS mark: transparent, monochrome, and stable across states. */
export function buildMacOsTraySvg(state: TrayIconState): string {
  return buildLucideSvg(
    [
      ["path", { d: COGNIA_ORBIT_PATH, fill: "#000000", stroke: "none" }],
      ...MACOS_STATE_NODES[state],
    ],
    "#000000"
  )
}

const DEFAULT_ATTRS: Record<string, string | number> = {
  xmlns: "http://www.w3.org/2000/svg",
  width: 24,
  height: 24,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": 2,
  "stroke-linecap": "round",
  "stroke-linejoin": "round",
}

/**
 * Build the `<svg>…</svg>` string for a Lucide icon. `color` substitutes
 * for `currentColor` so the rendered raster is concrete (canvas does not
 * resolve `currentColor`).
 */
export function buildLucideSvg(nodes: LucideNode[], color: string): string {
  const attrs: Record<string, string | number> = { ...DEFAULT_ATTRS, stroke: color }
  const open = `<svg ${serializeAttrs(attrs)}>`
  const body = nodes
    .map(([tag, nodeAttrs]) => `<${tag} ${serializeAttrs(camelToKebab(nodeAttrs))}/>`)
    .join("")
  return `${open}${body}</svg>`
}

function serializeAttrs(attrs: Record<string, string | number>): string {
  return Object.entries(attrs)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}="${escapeAttr(String(v))}"`)
    .join(" ")
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")
}

/**
 * Lucide's per-node attrs use camelCase (`strokeWidth`); SVG XML uses
 * kebab-case (`stroke-width`). The `key` attr is React-only — drop it.
 */
function camelToKebab(attrs: Record<string, string | number>): Record<string, string | number> {
  const out: Record<string, string | number> = {}
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "key") continue
    const kebab = k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)
    out[kebab] = v
  }
  return out
}

/**
 * Compact readout drawn onto the icon raster — the tray's "taskbar badge"
 * (`TrayDisplayPrefs.taskbarUsageMode === "iconBadge"`). `color` should be
 * the meter-status color so the badge doubles as a severity signal.
 */
export interface TrayIconBadge {
  text: string
  color: string
}

/** Render a macOS template glyph or the character with status/usage badges. */
export async function rasterizeSvgToPng(
  svg: string,
  size: number,
  badge?: TrayIconBadge,
  showStatus = true
): Promise<Uint8Array> {
  if (typeof document === "undefined") {
    throw new Error("rasterizeSvgToPng requires a DOM (document undefined)")
  }
  const template = isMacOs()
  const blob = new Blob([svg], { type: "image/svg+xml" })
  const url = URL.createObjectURL(blob)
  try {
    const [character, image] = await Promise.all([
      template ? Promise.resolve(null) : loadImage(characterIcon.src),
      loadImage(url),
    ])
    const canvas = document.createElement("canvas")
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext("2d")
    if (!ctx) throw new Error("2D canvas context unavailable")
    // High-quality downscale from the SVG's native 24×24 viewBox.
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = "high"
    ctx.clearRect(0, 0, size, size)
    // AppKit derives template images from alpha; the character and opaque
    // status plate would become solid silhouettes. Use the state glyph alone.
    ctx.drawImage(character ?? image, 0, 0, size, size)
    if (!template && showStatus) {
      const statusSize = size * 0.45
      ctx.fillStyle = "#ffffff"
      ctx.beginPath()
      ctx.roundRect(size - statusSize, 0, statusSize, statusSize, statusSize * 0.2)
      ctx.fill()
      ctx.drawImage(image, size - statusSize, 0, statusSize, statusSize)
    }
    if (badge) drawBadge(ctx, size, badge, template)
    return await canvasToPng(canvas)
  } finally {
    URL.revokeObjectURL(url)
  }
}

/**
 * Paint a rounded pill over the bottom-right quadrant carrying the compact
 * usage readout ("42%" → drawn as "42"; balances keep their short form).
 * Tray icons render at ~16-32 px, so the text is clamped to 3 glyphs —
 * anything longer would be unreadable at that size.
 *
 * Template badges cut the text out of the pill's alpha so AppKit can tint
 * both the icon and the readout in light, dark and highlighted appearances.
 */
export function drawBadge(
  ctx: CanvasRenderingContext2D,
  size: number,
  badge: TrayIconBadge,
  template = false
): void {
  const text = badge.text.replace(/%$/, "").slice(0, 3)
  if (!text) return
  const height = size * 0.55
  const width = size * (text.length >= 3 ? 0.8 : 0.66)
  const x = size - width
  const y = size - height
  const radius = height * 0.3

  ctx.save()
  ctx.beginPath()
  // roundRect is available in every WebView this app ships in (Chromium /
  // WebKit ≥ 2021); jsdom's canvas mock in tests stubs it.
  ctx.roundRect(x, y, width, height, radius)
  ctx.fillStyle = template ? "#000000" : badge.color
  ctx.fill()
  if (template) ctx.globalCompositeOperation = "destination-out"
  ctx.fillStyle = "#ffffff"
  ctx.textAlign = "center"
  ctx.textBaseline = "middle"
  ctx.font = `bold ${Math.round(height * 0.72)}px sans-serif`
  ctx.fillText(text, x + width / 2, y + height / 2 + height * 0.05, width * 0.9)
  ctx.restore()
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`failed to load svg image at ${src}`))
    img.src = src
  })
}

async function canvasToPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), "image/png")
  )
  if (!blob) throw new Error("canvas.toBlob returned null")
  const buf = await blob.arrayBuffer()
  return new Uint8Array(buf)
}

/**
 * Render every tray-icon state and push the resulting PNG bytes to Rust.
 * Idempotent — Rust caches by state, so calling this twice is safe.
 *
 * macOS uses black template glyphs; elsewhere `color` controls the status glyph.
 *
 * `size` defaults to 36 on macOS (18 points at Retina scale), 32 elsewhere.
 * The OS scales as needed.
 */
export async function rasterizeAndRegisterTrayIcons({
  color = "#000000",
  size = isMacOs() ? 36 : 32,
  badge,
}: { color?: string; size?: number; badge?: TrayIconBadge } = {}): Promise<void> {
  if (!isTauri()) return
  const states: TrayIconState[] = ["idle", "busy", "error", "muted"]
  await Promise.all(
    states.map(async (state) => {
      try {
        const svg = isMacOs() ? buildMacOsTraySvg(state) : buildLucideSvg(STATE_NODES[state], color)
        // The badge overlays every state so the readout survives busy/error
        // flips; Rust re-applies the current state's raster on registration
        // (`tray_register_icon`), so no extra `tray_set_icon_state` call is
        // needed for the swap to take effect.
        const png = await rasterizeSvgToPng(svg, size, badge, state !== "idle")
        await invoke("tray_register_icon", { state, pngBytes: Array.from(png) })
      } catch (err) {
        loggers.tray.warn("tray icon raster failed", { state, error: String(err) })
      }
    })
  )
}

/** Test-only escape hatch — exposes the inlined iconNodes so the test
 * can verify they round-trip through `buildLucideSvg` cleanly. */
export const __STATE_NODES_FOR_TESTING = STATE_NODES
