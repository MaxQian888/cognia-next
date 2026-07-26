#!/usr/bin/env node
/**
 * Product screenshot capture (ADR-0092 §8).
 *
 * Drives the real Cognia application with Playwright and writes the
 * *section × theme × locale* matrix into `web/public/product/`, plus the
 * manifest `web/content/generated/product-shots.json` that the site reads.
 *
 * Two rules this script exists to enforce:
 *
 *  1. **Never the author's data.** It seeds a purpose-built demo workspace
 *     through the same `window.__cognia*` test seams the E2E suite uses. A
 *     screenshot of a real working session would publish repository names,
 *     conversation contents and provider configuration.
 *  2. **Fail rather than produce a wrong asset.** Every section declares the
 *     selectors that must be visible before the shutter fires. If the product UI
 *     moved, the run fails with the section named — it does not quietly capture
 *     whatever happens to be on screen. A silently wrong screenshot is worse
 *     than a missing one, because the site renders an honest placeholder for a
 *     missing one.
 *
 * Prerequisites (the script checks and reports, it does not install):
 *   pnpm test:e2e:build          # NEXT_PUBLIC_E2E=1 static export into out/
 *   pnpm dlx serve out -l 4173   # or any static server for that export
 *
 * Usage:
 *   node web/scripts/capture-product.mjs --base-url http://localhost:4173
 *   node web/scripts/capture-product.mjs --only hero --locale en --theme dark
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const OUT_DIR = join(WEB_ROOT, "public", "product")
const MANIFEST = join(WEB_ROOT, "content", "generated", "product-shots.json")

const LOCALES = ["en", "zh"]
const THEMES = ["light", "dark"]

/** Viewport at capture time. DPR 2 so the shot stands up on a retina display. */
const VIEWPORT = { width: 1440, height: 900 }
const SCALE = 2

/**
 * The demo project every screenshot shows. Fictional on purpose: the signature
 * task needs a failing check and a pending release, and manufacturing those in
 * a real repository to take a photograph of them is worse than saying the
 * project is a demonstration.
 */
export const DEMO = {
  repository: "acme/checkout-service",
  branch: "release/2.4.0",
  failingCheck: "unit-tests",
  artifact: "launch-notes.md",
}

/**
 * One entry per matrix section. `requireVisible` is the guard: the shutter does
 * not fire until every selector resolves, and a timeout names the section.
 */
export const SECTIONS = [
  {
    key: "hero",
    route: "/",
    requireVisible: ['[data-testid="chat-pane"]'],
    clip: null,
  },
  {
    key: "workbench",
    route: "/",
    requireVisible: ['[data-testid="chat-pane"]', '[data-testid="artifact-workspace-dock"]'],
    clip: null,
  },
  {
    key: "desktop",
    route: "/",
    requireVisible: ['[data-testid="chat-pane"]'],
    // A macro crop of the shell rather than the whole window — the spec asks
    // for a close read of the workspace chrome, not a shrunken desktop.
    clip: { x: 0, y: 0, width: 960, height: 600 },
  },
]

export function parseArgs(argv) {
  const args = { baseUrl: "http://localhost:4173", only: null, locale: null, theme: null }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--base-url") args.baseUrl = argv[++i]
    else if (argv[i] === "--only") args.only = argv[++i]
    else if (argv[i] === "--locale") args.locale = argv[++i]
    else if (argv[i] === "--theme") args.theme = argv[++i]
  }
  return args
}

/**
 * Public path and on-disk filename for one cell of the matrix.
 *
 * PNG, not AVIF: `page.screenshot()` writes `png` or `jpeg` and nothing else, so
 * an AVIF matrix would need an image encoder (`sharp`) in `web/`'s dependency
 * set, which is deliberately five runtime packages wide. PNG is lossless, which
 * is the right call for UI screenshots — JPEG artefacts land on exactly the thin
 * type and hairline borders these shots exist to show.
 */
export function shotPaths(section, theme, locale) {
  const name = `${section}-${theme}-${locale}.png`
  return { file: join(OUT_DIR, name), src: `/product/${name}` }
}

/**
 * Replace every cell selected for this run while preserving cells outside the
 * filter. Selected cells are removed first so a failed recapture cannot leave
 * an older image advertised as the result of the new run.
 */
export function mergeShotManifest(existingManifest, selectedKeys, capturedShots, capturedAt) {
  const shots = { ...existingManifest.shots }
  for (const key of selectedKeys) delete shots[key]
  Object.assign(shots, capturedShots)
  return { capturedAt, shots }
}

function readShotManifest() {
  try {
    return JSON.parse(readFileSync(MANIFEST, "utf8"))
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { capturedAt: null, shots: {} }
    }
    throw error
  }
}

/**
 * The seam that seeds the signature task. It does NOT exist yet.
 *
 * `lib/dev/expose-test-globals.tsx` exposes `__cogniaSetSettings`,
 * `__cogniaResetDb`, `__cogniaSeedTeam`, `__cogniaSeedRun`,
 * `__cogniaSeedWorkflow` and friends — enough to seed a team or a run, but
 * nothing that produces a chat session carrying a plan, a diff, an approval
 * checkpoint, a test result and an artifact together. That composite is exactly
 * what the signature task's screenshots need.
 *
 * Adding it is a product-side change (dev-only, behind the same
 * `NEXT_PUBLIC_E2E` gate as every other global), not a website change, so this
 * script names the file rather than guessing at a global that is not there.
 */
const SEED_SEAM = "__cogniaSeedDemoWorkspace"

/**
 * Put the application into a known state: demo locale, theme, and a seeded
 * workspace holding the signature task. Uses the same seams as the E2E suite,
 * so it stays correct as those evolve rather than duplicating their logic.
 */
async function prepare(page, { locale, theme }) {
  await page.waitForFunction(() => typeof window.__cogniaSetSettings === "function", {
    timeout: 60_000,
  })

  const seamPresent = await page.evaluate(
    (seam) => typeof (/** @type {any} */ (window)[seam]) === "function",
    SEED_SEAM
  )
  if (!seamPresent) {
    throw new Error(
      `window.${SEED_SEAM} is not exposed. Add it to lib/dev/expose-test-globals.tsx ` +
        "(dev-only, behind the existing NEXT_PUBLIC_E2E gate) so a capture run can seed the " +
        "signature task — repository context, plan, failing check, diff, approval checkpoint, " +
        "test output and the launch-notes artifact — without touching real data."
    )
  }

  await page.evaluate(
    async ({ locale: lang, theme: mode, demo, seam }) => {
      const w = /** @type {any} */ (window)
      await w.__cogniaSetSettings({
        locale: lang === "zh" ? "zh-CN" : "en",
        theme: mode,
      })
      await w[seam](demo)
    },
    { locale, theme, demo: DEMO, seam: SEED_SEAM }
  )

  // Motion has to be off, or two runs of the same cell differ.
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: theme })
  await page.waitForTimeout(400)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  const { loadChromium } = await import("./capture-og.mjs")
  const chromium = await loadChromium()
  if (!chromium) {
    console.error("[capture] neither `playwright` nor `@playwright/test` resolves here")
    process.exit(1)
  }

  const sections = args.only ? SECTIONS.filter((s) => s.key === args.only) : SECTIONS
  const locales = args.locale ? [args.locale] : LOCALES
  const themes = args.theme ? [args.theme] : THEMES
  if (sections.length === 0) {
    console.error(`[capture] no section matches --only ${args.only}`)
    process.exit(1)
  }
  if (args.locale && !LOCALES.includes(args.locale)) {
    console.error(
      `[capture] unsupported locale ${args.locale}; expected one of ${LOCALES.join(", ")}`
    )
    process.exit(1)
  }
  if (args.theme && !THEMES.includes(args.theme)) {
    console.error(`[capture] unsupported theme ${args.theme}; expected one of ${THEMES.join(", ")}`)
    process.exit(1)
  }

  mkdirSync(OUT_DIR, { recursive: true })
  const existingManifest = readShotManifest()
  const selectedKeys = locales.flatMap((locale) =>
    themes.flatMap((theme) => sections.map((section) => `${section.key}-${theme}-${locale}`))
  )
  const browser = await chromium.launch()
  const shots = {}
  const failures = []

  try {
    for (const locale of locales) {
      for (const theme of themes) {
        const context = await browser.newContext({
          viewport: VIEWPORT,
          deviceScaleFactor: SCALE,
          colorScheme: theme,
          reducedMotion: "reduce",
        })
        const page = await context.newPage()

        for (const section of sections) {
          const label = `${section.key}-${theme}-${locale}`
          try {
            await page.goto(`${args.baseUrl}${section.route}`, { waitUntil: "domcontentloaded" })
            await prepare(page, { locale, theme })

            for (const selector of section.requireVisible) {
              await page.locator(selector).first().waitFor({ state: "visible", timeout: 30_000 })
            }

            const { file, src } = shotPaths(section.key, theme, locale)
            await page.screenshot({
              path: file,
              type: "png",
              clip: section.clip ?? undefined,
            })

            const width = (section.clip?.width ?? VIEWPORT.width) * SCALE
            const height = (section.clip?.height ?? VIEWPORT.height) * SCALE
            shots[label] = { src, width, height }
            console.log(`[capture] ${label}`)
          } catch (error) {
            // Named, not swallowed: the manifest simply will not contain this
            // cell, and the site renders its placeholder.
            failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`)
            console.error(`[capture] FAILED ${label}`)
          }
        }

        await context.close()
      }
    }
  } finally {
    await browser.close()
  }

  const manifest = mergeShotManifest(
    existingManifest,
    selectedKeys,
    shots,
    new Date().toISOString()
  )
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")

  console.log(
    `[capture] wrote ${Object.keys(shots).length} selected shot(s); ` +
      `manifest now contains ${Object.keys(manifest.shots).length}`
  )
  for (const failure of failures) console.error(`[capture] ${failure}`)
  if (failures.length > 0) process.exit(1)
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await main()
}
