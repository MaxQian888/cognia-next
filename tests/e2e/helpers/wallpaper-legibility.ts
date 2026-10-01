/**
 * Shared instrument for the wallpaper legibility specs: fixtures (hard-edged
 * stripe wallpapers, theme cases), app mounting through the settings bridge,
 * and two measurements taken from real rendered pixels —
 *
 *  - `measureTextBackdrops`: hide every glyph, screenshot, and rate each
 *    theme-coloured text box against the backdrop pixels behind it;
 *  - `findOpaqueIslands`: large boxes painted a solid theme fill straight over
 *    the wallpaper (a panel that should blend but stays a block).
 */

import type { Page } from "@playwright/test"

import { expect } from "@/tests/e2e/fixtures/test"
import { DEFAULT_A11Y, DEFAULT_BACKGROUND_SETTINGS, type Wallpaper } from "@/types/appearance"
import { ensureCogniaAccount } from "./db-reset"

export function stripes(id: string, a: string, b: string): Wallpaper {
  return {
    id,
    name: id,
    kind: "gradient",
    source: {
      kind: "gradient",
      css: `repeating-linear-gradient(90deg, ${a} 0 96px, ${b} 96px 192px)`,
    },
    builtin: false,
    createdAt: 1,
  }
}

export const WALLPAPERS = {
  night: stripes("wp_e2e_night", "#04060d", "#1b2440"),
  paper: stripes("wp_e2e_paper", "#fbf8f1", "#e3dccb"),
  busy: stripes("wp_e2e_busy", "#050505", "#fafafa"),
}

export type ThemeCase = {
  name: string
  colorScheme: "light" | "dark"
  settings: Record<string, unknown>
}

export const THEMES: ThemeCase[] = [
  { name: "light", colorScheme: "light", settings: { theme: "light" } },
  { name: "dark", colorScheme: "dark", settings: { theme: "dark" } },
  {
    name: "high-contrast dark",
    colorScheme: "dark",
    settings: { theme: "dark", a11y: { ...DEFAULT_A11Y, highContrast: "dark" } },
  },
  { name: "ocean preset", colorScheme: "light", settings: { theme: "light", colorTheme: "ocean" } },
]

/** WCAG relative luminance of 0..255 sRGB channels. */
export function luminance(r: number, g: number, b: number): number {
  const f = (v: number) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

export function contrast(a: number, b: number): number {
  const [hi, lo] = a > b ? [a, b] : [b, a]
  return (hi + 0.05) / (lo + 0.05)
}

export interface TextSample {
  text: string
  role: "foreground" | "muted"
  box: { x: number; y: number; width: number; height: number }
  /** Text colour as 0..255 sRGB. */
  rgb: [number, number, number]
  /** Contrast of this text on the bare theme background — its native ratio. */
  native: number
}

export interface MeasuredSample extends TextSample {
  /** Worst contrast against the backdrop pixels in the text's own box. */
  worst: number
}

/**
 * Every visible element under `within` (a selector; default the whole page)
 * whose own text is painted in `--foreground` or `--muted-foreground`, with
 * the colour resolved by the engine. Colour spaces
 * are normalised through a 1×1 canvas so oklch/lab tokens compare as sRGB.
 */
export async function collectThemeText(page: Page, within = "body"): Promise<TextSample[]> {
  return page.evaluate((within) => {
    const canvas = document.createElement("canvas")
    canvas.width = canvas.height = 1
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!
    const toRgb = (css: string): [number, number, number, number] => {
      ctx.clearRect(0, 0, 1, 1)
      ctx.fillStyle = "#000"
      ctx.fillStyle = css
      ctx.fillRect(0, 0, 1, 1)
      const d = ctx.getImageData(0, 0, 1, 1).data
      return [d[0]!, d[1]!, d[2]!, d[3]! / 255]
    }
    const probe = document.createElement("span")
    document.body.appendChild(probe)
    const resolve = (v: string) => {
      probe.style.color = `var(${v})`
      return toRgb(getComputedStyle(probe).color)
    }
    const fg = resolve("--foreground")
    const muted = resolve("--muted-foreground")
    const bg = resolve("--background")
    probe.remove()
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => {
        const c = v / 255
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!)
    }
    const ratio = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
    const same = (a: number[], b: number[]) =>
      a.slice(0, 3).every((v, i) => Math.abs(v - b[i]!) <= 2)

    const out: TextSample[] = []
    for (const el of document.querySelectorAll<HTMLElement>(`:is(${within}) *`)) {
      const own = [...el.childNodes].some(
        (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim().length > 1
      )
      if (!own) continue
      // Colour emoji are bitmaps that ignore `color`: hiding the text leaves
      // them painted, and they would be measured as their own backdrop.
      const text = el.textContent ?? ""
      if (!/\p{L}/u.test(text) || /\p{Extended_Pictographic}/u.test(text)) continue
      const cs = getComputedStyle(el)
      if (cs.visibility !== "visible" || Number(cs.opacity) < 1) continue
      // The box of the element's own text, not the element: a label that
      // wraps its radio, or a row that holds a badge, would otherwise measure
      // that control's own fill and border as the text's backdrop.
      const range = document.createRange()
      const textNodes = [...el.childNodes].filter(
        (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim().length > 0
      )
      range.setStartBefore(textNodes[0]!)
      range.setEndAfter(textNodes[textNodes.length - 1]!)
      // Clipped to the element's own box — a clamped paragraph's range still
      // spans the lines `line-clamp` hid, and an `sr-only` span's spans text
      // its 1px box never paints.
      const textBox = range.getBoundingClientRect()
      const ownBox = el.getBoundingClientRect()
      const left = Math.max(textBox.left, ownBox.left)
      const top = Math.max(textBox.top, ownBox.top)
      let clip = {
        left,
        top,
        right: Math.min(textBox.right, ownBox.right),
        bottom: Math.min(textBox.bottom, ownBox.bottom),
      }
      // …and to every clipping ancestor: a row scrolled out of a list's
      // viewport keeps its box but paints nothing there.
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        if (getComputedStyle(p).overflow === "visible") continue
        const c = p.getBoundingClientRect()
        clip = {
          left: Math.max(clip.left, c.left),
          top: Math.max(clip.top, c.top),
          right: Math.min(clip.right, c.right),
          bottom: Math.min(clip.bottom, c.bottom),
        }
      }
      const r = new DOMRect(clip.left, clip.top, clip.right - clip.left, clip.bottom - clip.top)
      if (r.width < 24 || r.height < 10 || r.top < 0 || r.bottom > innerHeight) continue
      if (r.left < 0 || r.right > innerWidth) continue
      const color = toRgb(cs.color)
      // Translucent text (a `text-muted-foreground/70` hint) is its own
      // design decision; the guard's contract is about the theme tokens.
      if (color[3] < 1) continue
      const role = same(color, fg) ? "foreground" : same(color, muted) ? "muted" : null
      if (!role) continue
      out.push({
        text: (el.textContent ?? "").trim().slice(0, 40),
        role,
        box: { x: r.x, y: r.y, width: r.width, height: r.height },
        rgb: [color[0], color[1], color[2]],
        native: ratio(lum(color), lum(bg)),
      })
    }
    return out
  }, within)
}

/**
 * Hide every glyph and icon, screenshot, and return the worst contrast each
 * sample's text would have against the backdrop pixels in its own box (3rd /
 * 97th luminance percentile — a stray antialiased edge is not a patch).
 *
 * The hiding style stays on the page; take every other measurement first.
 */
export async function measureTextBackdrops(
  page: Page,
  samples: TextSample[]
): Promise<MeasuredSample[]> {
  // The development server's indicator ("Compiling…") lives in a shadow root
  // the glyph rule cannot reach and floats over the sidebar; it is not app UI.
  await page.addStyleTag({
    content: `*, *::before, *::after { color: transparent !important; text-shadow: none !important;
      caret-color: transparent !important; }
      *::placeholder { color: transparent !important; }
      svg, img, canvas, video { visibility: hidden !important; }
      nextjs-portal { display: none !important; }`,
  })
  // Let transitions on colour settle before the pixels are read.
  await page.waitForTimeout(400)
  const png = await page.screenshot()
  const viewportWidth = page.viewportSize()?.width ?? 0
  // Decoded by the browser's own PNG decoder and percentiled in the page: a
  // canvas hands back the raw sRGB pixels with no image library to depend on,
  // and only one pair of numbers per sample crosses back.
  const extremes = await page.evaluate(
    async ({ base64, boxes, viewportWidth }) => {
      const img = new Image()
      img.src = `data:image/png;base64,${base64}`
      await img.decode()
      const canvas = document.createElement("canvas")
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!
      ctx.drawImage(img, 0, 0)
      const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height)
      const lin = (v: number) => {
        const c = v / 255
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
      }
      const scale = viewportWidth > 0 ? width / viewportWidth : 1
      return boxes.map((box) => {
        const lums: number[] = []
        const x0 = Math.max(0, Math.floor((box.x + 1) * scale))
        const y0 = Math.max(0, Math.floor((box.y + 1) * scale))
        const x1 = Math.min(width, Math.ceil((box.x + box.width - 1) * scale))
        const y1 = Math.min(height, Math.ceil((box.y + box.height - 1) * scale))
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const i = (y * width + x) * 4
            lums.push(
              0.2126 * lin(data[i]!) + 0.7152 * lin(data[i + 1]!) + 0.0722 * lin(data[i + 2]!)
            )
          }
        }
        if (lums.length === 0) return null
        lums.sort((a, b) => a - b)
        const at = (q: number) => lums[Math.round(q * (lums.length - 1))]!
        return [at(0.03), at(0.97)] as [number, number]
      })
    },
    { base64: png.toString("base64"), boxes: samples.map((s) => s.box), viewportWidth }
  )
  return samples.map((s, i) => {
    const text = luminance(...s.rgb)
    const pair = extremes[i]
    return {
      ...s,
      worst: pair ? Math.min(contrast(text, pair[0]), contrast(text, pair[1])) : Infinity,
    }
  })
}

/**
 * Samples below the guard's targets — 4.5:1 for foreground, 3:1 for muted,
 * each capped at 95% of what the bare theme achieves — with 10% slack for
 * antialiasing and sub-pixel box edges.
 */
export function legibilityFailures(measured: MeasuredSample[]): MeasuredSample[] {
  return measured.filter((s) => {
    const target = Math.min(s.role === "foreground" ? 4.5 : 3, s.native * 0.95)
    return s.worst < target * 0.9
  })
}

export function describeSample(s: MeasuredSample): string {
  return `${s.role} "${s.text}" ${s.worst.toFixed(2)}:1`
}

export interface OpaqueIsland {
  /** `tag[data-slot]` plus the first classes — enough to find it in source. */
  label: string
  /** The theme token its fill matches. */
  token: string
  width: number
  height: number
}

/**
 * Boxes of at least `minArea` px² painted a solid theme fill (`--background`,
 * `--card`, `--popover`, `--muted`, `--secondary`, `--sidebar`) whose own
 * backdrop is the wallpaper — no opaque ancestor between them and the nearest
 * `[data-bg-target]`. An island inside an opaque island is not reported: the
 * outer one is the defect. Skipped as intended: open overlays (dialogs, menus —
 * they float above everything and are meant to be solid enough to read),
 * selection indicators (solid is the affordance on glass), and shells that
 * contain a wallpaper target (the target repaints the image over them).
 */
export async function findOpaqueIslands(page: Page, minArea = 6000): Promise<OpaqueIsland[]> {
  return page.evaluate((minArea) => {
    const canvas = document.createElement("canvas")
    canvas.width = canvas.height = 1
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!
    const toRgba = (css: string): [number, number, number, number] => {
      ctx.clearRect(0, 0, 1, 1)
      ctx.fillStyle = "rgba(0,0,0,0)"
      ctx.fillStyle = css
      ctx.fillRect(0, 0, 1, 1)
      const d = ctx.getImageData(0, 0, 1, 1).data
      return [d[0]!, d[1]!, d[2]!, d[3]! / 255]
    }
    const probe = document.createElement("span")
    document.body.appendChild(probe)
    const tokens = ["background", "card", "popover", "muted", "secondary", "sidebar"].map(
      (name) => {
        probe.style.color = `var(--${name})`
        return { name, rgba: toRgba(getComputedStyle(probe).color) }
      }
    )
    probe.remove()
    const near = (a: number[], b: number[]) =>
      a.slice(0, 3).every((v, i) => Math.abs(v - b[i]!) <= 3)
    const solidToken = (el: Element): string | null => {
      const cs = getComputedStyle(el)
      const fill = toRgba(cs.backgroundColor)
      if (fill[3] < 0.97 || cs.backgroundImage.includes("url(")) return null
      return tokens.find((t) => near(fill, t.rgba))?.name ?? null
    }
    const overlay =
      '[role="dialog"],[role="menu"],[role="listbox"],[data-radix-popper-content-wrapper],[data-state="open"][data-slot$="-content"]'
    const selected =
      '[aria-current]:not([aria-current="false"]),[aria-selected="true"],[aria-pressed="true"],[data-active="true"],[data-state="active"],[data-state="on"],[data-state="checked"]'
    const out: { label: string; token: string; width: number; height: number }[] = []
    for (const el of document.querySelectorAll<HTMLElement>("[data-bg-target] *")) {
      const r = el.getBoundingClientRect()
      if (r.width * r.height < minArea || r.bottom <= 0 || r.top >= innerHeight) continue
      if (getComputedStyle(el).visibility !== "visible") continue
      if (el.closest(overlay)) continue
      // A box that holds a wallpaper target is repainted by that target's own
      // layer wherever the target reaches; it is the shell, not an island.
      if (el.querySelector("[data-bg-target]")) continue
      // Selection is drawn solid on purpose: on glass, a solid fill is what
      // says "this one" (the selected row, the active tab, a pressed toggle).
      if (el.closest(selected)) continue
      // A sliding selection pill is its own decorative layer beside the row
      // it marks, so it carries no state of its own — its selected sibling does.
      if (
        el.getAttribute("aria-hidden") === "true" &&
        el.parentElement?.querySelector(`:scope > :is(${selected})`)
      )
        continue
      const token = solidToken(el)
      if (!token) continue
      // Walk up to the wallpaper target: an opaque ancestor means this box is
      // not over the image at all.
      let covered = false
      for (let p = el.parentElement; p && !p.hasAttribute("data-bg-target"); p = p.parentElement) {
        if (solidToken(p) || toRgba(getComputedStyle(p).backgroundColor)[3] >= 0.97) {
          covered = true
          break
        }
      }
      if (covered) continue
      const slot = el.getAttribute("data-slot")
      const classes = (typeof el.className === "string" ? el.className : "")
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 6)
        .join(".")
      out.push({
        label: `${el.tagName.toLowerCase()}${slot ? `[data-slot=${slot}]` : ""}${classes ? `.${classes}` : ""}`,
        token,
        width: Math.round(r.width),
        height: Math.round(r.height),
      })
    }
    return out
  }, minArea)
}

/**
 * Wait until the app can take settings. The shared `ensureAppMounted` ends by
 * waiting on the test globals' and plugin runtime's ready flags, which only
 * flip after unrelated provider cleanup and plugin discovery settle; these
 * specs need neither — only an unlocked account and the settings bridge. So it
 * provisions the account itself when the first-run form shows, re-boots the
 * way the shared helper does (via about:blank, so the old document's database
 * connections close first), and waits for the bridge.
 */
export async function mountApp(page: Page): Promise<void> {
  // "settled" once settings are loaded: the onboarding gate renders either the
  // first-run screen or a route's own wallpaper target only after the row is
  // read (a save made before that is overwritten by the load). "form" when the
  // first-run account form stays up — a development server provisions a
  // disposable account for a fresh profile and the form can flash first, and
  // creating a second account would route it through onboarding.
  const settle = () =>
    page.waitForFunction(
      () => {
        const w = window as Window & { __cogniaSetSettings?: unknown; __e2eFormSeenAt?: number }
        if (document.querySelector('form[aria-label="Create local account"]')) {
          w.__e2eFormSeenAt ??= Date.now()
          return Date.now() - w.__e2eFormSeenAt > 30_000 ? "form" : null
        }
        w.__e2eFormSeenAt = undefined
        if (typeof w.__cogniaSetSettings !== "function") return null
        const routeTarget = document.querySelector("[data-bg-target]:not(#app)") !== null
        const onboarding = [...document.querySelectorAll("button")].some((b) =>
          /Set up for me/.test(b.textContent ?? "")
        )
        return routeTarget || onboarding ? "settled" : null
      },
      undefined,
      { timeout: 90_000, polling: 250 }
    )
  if ((await (await settle()).jsonValue()) === "form") {
    await ensureCogniaAccount(page)
    const url = page.url()
    await page.goto("about:blank")
    await page.goto(url, { waitUntil: "domcontentloaded" })
    await settle()
  }
}

/**
 * Save through the app's own settings store. Called directly rather than via
 * `setCogniaSettings`, which also waits on the test globals' ready flag — a
 * flag that flips only after unrelated provider cleanup settles.
 */
export async function saveSettings(page: Page, patch: Record<string, unknown>): Promise<void> {
  await page.waitForFunction(
    () =>
      typeof (window as Window & { __cogniaSetSettings?: unknown }).__cogniaSetSettings ===
      "function",
    undefined,
    { timeout: 60_000 }
  )
  await page.evaluate(async (p) => {
    const w = window as Window & {
      __cogniaSetSettings: (patch: Record<string, unknown>) => Promise<void>
    }
    await w.__cogniaSetSettings(p)
  }, patch)
}

export async function completeOnboarding(page: Page): Promise<void> {
  await saveSettings(page, {
    onboardingProgress: {
      version: 2,
      path: "completed",
      completedAt: "2026-01-01T00:00:00.000Z",
    },
  })
}

export async function showWallpaper(page: Page, wallpaper: Wallpaper, theme: ThemeCase) {
  await saveSettings(page, {
    ...theme.settings,
    wallpapers: [wallpaper],
    background: {
      ...DEFAULT_BACKGROUND_SETTINGS,
      enabled: true,
      activeId: wallpaper.id,
      scope: "all",
      opacity: 1,
      legibilityGuard: true,
    },
  })
}

export async function waitForCap(page: Page): Promise<number> {
  await expect
    .poll(() => page.evaluate(() => document.body.style.getPropertyValue("--wp-max-weight")), {
      timeout: 30_000,
    })
    .not.toBe("")
  return Number(await page.evaluate(() => document.body.style.getPropertyValue("--wp-max-weight")))
}
