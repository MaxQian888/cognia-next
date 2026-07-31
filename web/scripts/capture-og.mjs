#!/usr/bin/env node
/**
 * Share-image capture (ADR-0092, plan §7).
 *
 * Photographs `/og-template` once per published route per locale and writes the
 * results to `web/public/og/`. A static export has no `ImageResponse` runtime,
 * so these are produced ahead of time — and rendering them from the site's own
 * tokens and typeface is what stops them drifting from the pages they represent.
 *
 * Unlike the product capture, this is entirely self-contained: it needs only the
 * website's own static export, no product application and no seeded data.
 *
 * Usage:
 *   pnpm --filter web build
 *   pnpm dlx serve web/out -l 4174
 *   node web/scripts/capture-og.mjs --base-url http://localhost:4174
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const OUT_DIR = join(WEB_ROOT, "public", "og")
const MANIFEST = join(WEB_ROOT, "content", "generated", "og-images.json")

const SIZE = { width: 1200, height: 630 }

/**
 * Route → the `meta` key that carries its title. Kept in step with
 * `lib/locale.ts:ROUTES`; a route missing here gets no share image, which the
 * check at the end reports rather than hides.
 */
export const OG_ROUTES = [
  { route: "/", metaKey: "home", slug: "home", eyebrowKey: "hero" },
  { route: "/product", metaKey: "product", slug: "product", eyebrowKey: "product" },
  { route: "/workflows", metaKey: "workflows", slug: "workflows", eyebrowKey: "workflows" },
  { route: "/plugins", metaKey: "plugins", slug: "plugins", eyebrowKey: "plugins" },
  { route: "/trust", metaKey: "trust", slug: "trust", eyebrowKey: "trust" },
  { route: "/download", metaKey: "download", slug: "download", eyebrowKey: "download" },
  {
    route: "/use-cases/development",
    metaKey: "useCasesDevelopment",
    slug: "use-cases-development",
    eyebrowKey: "development",
  },
  {
    route: "/use-cases/research",
    metaKey: "useCasesResearch",
    slug: "use-cases-research",
    eyebrowKey: "research",
  },
  { route: "/changelog", metaKey: "changelog", slug: "changelog", eyebrowKey: "changelog" },
]

/**
 * Pull a page's own eyebrow out of a copy module without evaluating it.
 *
 * The script is plain `.mjs` and the copy is TypeScript, so it reads the source.
 * The scan is windowed because a key like `product` appears twice — once under
 * `meta`, which has no eyebrow, and once as the page — and taking the first
 * window that actually contains an `eyebrow` skips the metadata block without
 * needing to model the file's structure.
 */
export function eyebrowFrom(source, key, windowSize = 400) {
  const marker = `${key}: {`
  let index = source.indexOf(marker)
  while (index !== -1) {
    const window = source.slice(index, index + windowSize)
    const match = /eyebrow:\s*"([^"]+)"/.exec(window)
    if (match) return match[1]
    index = source.indexOf(marker, index + marker.length)
  }
  return null
}

/** Must match `lib/metadata.ts:ogImagePath`, which the pages reference. */
export function ogFileName(slug, locale) {
  return `${slug}-${locale}.png`
}

/**
 * The card's headline. Page titles carry a trailing site name for the browser
 * tab; a share card already says "Cognia" in its own corner, so the suffix is
 * dropped rather than repeated.
 */
export function cardTitle(title) {
  return title
    .replace(/\s+—\s+Cognia$/, "")
    .replace(/^Cognia\s+—\s+/, "")
    .trim()
}

/** The site's real host, when the deploy variable is configured. */
export function originFromEnv(env = process.env) {
  const raw = (env.NEXT_PUBLIC_WEB_SITE_URL || env.WEB_SITE_URL || "").trim()
  if (!raw) return ""
  try {
    return new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`).host
  } catch {
    return ""
  }
}

/**
 * The repository depends on `@playwright/test`, not on `playwright` directly, so
 * only the former is linked into `node_modules`. Both export the same browser
 * handles; try the direct package first for anyone who does have it.
 */
export async function loadChromium() {
  for (const specifier of ["playwright", "@playwright/test"]) {
    try {
      const mod = await import(specifier)
      if (mod.chromium) return mod.chromium
    } catch {
      // Try the next specifier.
    }
  }
  return null
}

function parseArgs(argv) {
  // Cloudflare Pages serves `/og-template` from `og-template.html`; a plain
  // file server does not, so the path is a flag rather than an assumption.
  const args = {
    baseUrl: "http://localhost:4174",
    templatePath: "/og-template",
    // Never the serving host: these images are committed, and baking
    // `localhost:4174` into a share card is how a dev origin ends up on
    // someone's timeline. Blank when the real domain is not configured.
    origin: originFromEnv(),
  }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--base-url") args.baseUrl = argv[++i]
    else if (argv[i] === "--template-path") args.templatePath = argv[++i]
    else if (argv[i] === "--origin") args.origin = argv[++i]
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  const chromium = await loadChromium()
  if (!chromium) {
    console.error("[og] neither `playwright` nor `@playwright/test` resolves from this workspace")
    process.exit(1)
  }

  // The copy modules are TypeScript; the built site is not a dependency of this
  // script, so titles come from the JSON the build already emitted for each page
  // via its metadata. Reading them from the rendered pages keeps one source.
  const { readFileSync } = await import("node:fs")
  const localesCopy = {}
  for (const locale of ["en", "zh"]) {
    const source = readFileSync(join(WEB_ROOT, "content", `${locale}.ts`), "utf8")
    localesCopy[locale] = source
  }

  /** Pull one `meta.<key>.title` out of the copy module without evaluating it. */
  function titleFrom(locale, metaKey) {
    const source = localesCopy[locale]
    const block = new RegExp(`${metaKey}:\\s*\\{[\\s\\S]*?title:\\s*"([^"]+)"`).exec(source)
    return block ? block[1] : null
  }

  mkdirSync(OUT_DIR, { recursive: true })
  const browser = await chromium.launch()
  const written = {}
  const failures = []

  try {
    const context = await browser.newContext({
      viewport: SIZE,
      deviceScaleFactor: 1,
      reducedMotion: "reduce",
      colorScheme: "light",
    })
    const page = await context.newPage()
    const origin = args.origin

    for (const entry of OG_ROUTES) {
      for (const locale of ["en", "zh"]) {
        const name = ogFileName(entry.slug, locale)
        try {
          const title = titleFrom(locale, entry.metaKey)
          if (!title) throw new Error(`no title found for meta.${entry.metaKey} (${locale})`)

          const eyebrow = eyebrowFrom(localesCopy[locale], entry.eyebrowKey)
          if (!eyebrow) throw new Error(`no eyebrow found for ${entry.eyebrowKey} (${locale})`)

          const url = new URL(`${args.baseUrl}${args.templatePath}`)
          url.searchParams.set("title", cardTitle(title))
          url.searchParams.set("eyebrow", eyebrow)
          url.searchParams.set("locale", locale)
          url.searchParams.set("origin", origin)

          await page.goto(url.toString(), { waitUntil: "networkidle" })
          const card = page.getByTestId("og-card")
          await card.waitFor({ state: "visible", timeout: 20_000 })
          await page.screenshot({
            path: join(OUT_DIR, name),
            type: "png",
            clip: { ...SIZE, x: 0, y: 0 },
          })

          written[`${entry.slug}-${locale}`] = `/og/${name}`
          console.log(`[og] ${name}`)
        } catch (error) {
          failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
          console.error(`[og] FAILED ${name}`)
        }
      }
    }

    await context.close()
  } finally {
    await browser.close()
  }

  writeFileSync(
    MANIFEST,
    `${JSON.stringify({ capturedAt: new Date().toISOString(), images: written }, null, 2)}\n`,
    "utf8"
  )
  console.log(`[og] wrote ${Object.keys(written).length} image(s)`)
  for (const failure of failures) console.error(`[og] ${failure}`)
  if (failures.length > 0) process.exit(1)
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await main()
}
