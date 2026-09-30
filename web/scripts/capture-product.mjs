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
 *  1. **Never the author's data.** It plays the signature task
 *     (`demo-transcript.mjs`) into a fresh E2E build through the staged
 *     conversation seam (`demo-session.mjs`), the same one the film recorder
 *     uses. A screenshot of a real working session would publish repository
 *     names, conversation contents and provider configuration.
 *  2. **Fail rather than produce a wrong asset.** Every section declares the
 *     selectors that must be visible before the shutter fires. If the product UI
 *     moved, the run fails with the section named — it does not quietly capture
 *     whatever happens to be on screen. A silently wrong screenshot is worse
 *     than a missing one, because the site renders an honest placeholder for a
 *     missing one.
 *
 * Prerequisites (the script checks and reports, it does not install):
 *   pnpm test:e2e:build                                  # NEXT_PUBLIC_E2E=1 static export into out/
 *   node scripts/e2e/serve-out.mjs --port 4173           # serves that export
 *
 * Usage:
 *   node web/scripts/capture-product.mjs --base-url http://localhost:4173
 *   node web/scripts/capture-product.mjs --only hero --locale en --theme dark
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { CHAT_SURFACE_SELECTOR } from "./demo-session.mjs"
import { DEMO } from "./demo-transcript.mjs"

export { DEMO }

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const OUT_DIR = join(WEB_ROOT, "public", "product")
const MANIFEST = join(WEB_ROOT, "content", "generated", "product-shots.json")

const LOCALES = ["en", "zh"]
const THEMES = ["light", "dark"]

/** The thread's own "Jump to latest" pill. */
export const JUMP_TO_LATEST_SELECTOR = '[data-testid="conversation-jump-pill"]'

/** Viewport at capture time. DPR 2 so the shot stands up on a retina display. */
const VIEWPORT = { width: 1440, height: 900 }
const SCALE = 2

/**
 * One entry per matrix section. `requireVisible` is the guard: the shutter does
 * not fire until every selector resolves, and a timeout names the section.
 */
export const SECTIONS = [
  {
    key: "hero",
    requireVisible: [CHAT_SURFACE_SELECTOR],
    clip: null,
  },
  {
    key: "workbench",
    requireVisible: [CHAT_SURFACE_SELECTOR, '[data-testid="artifact-workspace-dock"]'],
    clip: null,
  },
  {
    key: "desktop",
    requireVisible: [CHAT_SURFACE_SELECTOR],
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
 * Put the application into the signature task's final state — every stage
 * played, halted on the push approval — for one locale and theme. Every
 * section of that cell is shot from this one state, so the hero, workbench and
 * desktop crops agree with each other and with the film.
 */
async function prepare(page, { baseUrl, locale, theme }) {
  const { openDemoSession } = await import("./demo-session.mjs")
  const session = await openDemoSession(page, { baseUrl, locale, theme })
  let result = { done: false }
  while (!result.done) result = await session.advance()
  // Motion has to be off, or two runs of the same cell differ.
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: theme })
  await page.waitForTimeout(600)
  // Stages played back to back outrun the thread's follow-scroll, which then
  // offers "Jump to latest". Take it so the still shows the end of the task
  // rather than its middle. Through the element's own click handler, not a
  // pointer click: the approval dialog's overlay sits above the thread and
  // would swallow the pointer.
  const jump = page.locator(JUMP_TO_LATEST_SELECTOR).first()
  if (await jump.isVisible().catch(() => false)) {
    await jump.evaluate((el) => /** @type {HTMLElement} */ (el).click())
    await page.waitForTimeout(800)
  }
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
        let prepared = null

        for (const section of sections) {
          const label = `${section.key}-${theme}-${locale}`
          try {
            // Once per cell; a failure is recorded against every section in it.
            prepared ??= prepare(page, { baseUrl: args.baseUrl, locale, theme })
            await prepared

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
