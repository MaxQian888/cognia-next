import assert from "node:assert/strict"
import test from "node:test"

import { OG_ROUTES, cardTitle, eyebrowFrom, ogFileName, originFromEnv } from "./capture-og.mjs"
import { DEMO, SECTIONS, shotPaths } from "./capture-product.mjs"

test("ogFileName matches what lib/metadata.ts:ogImagePath references", () => {
  // The pages reference `/og/<slug>-<locale>.png`. If these two drift, every
  // share card 404s while the markup still claims one exists.
  assert.equal(ogFileName("use-cases-research", "zh"), "use-cases-research-zh.png")
  assert.equal(ogFileName("home", "en"), "home-en.png")
})

test("OG_ROUTES covers every published route exactly once", async () => {
  const { readFileSync } = await import("node:fs")
  const { fileURLToPath } = await import("node:url")
  const { dirname, join } = await import("node:path")
  const here = dirname(fileURLToPath(import.meta.url))
  const localeSource = readFileSync(join(here, "..", "lib", "locale.ts"), "utf8")

  const declared = [...localeSource.matchAll(/^\s{2}"(\/[^"]*)",$/gm)].map((m) => m[1])
  assert.ok(declared.length > 0, "expected to parse ROUTES out of lib/locale.ts")

  const covered = OG_ROUTES.map((entry) => entry.route)
  assert.deepEqual([...covered].sort(), [...declared].sort())
  assert.equal(new Set(covered).size, covered.length)
})

test("OG slugs are unique, so no two pages overwrite each other's image", () => {
  const slugs = OG_ROUTES.map((entry) => entry.slug)
  assert.equal(new Set(slugs).size, slugs.length)
})

test("cardTitle drops the site-name suffix the browser tab needs", () => {
  assert.equal(cardTitle("Trust — Cognia"), "Trust")
})

test("cardTitle drops a leading site name too — the card already says it", () => {
  assert.equal(
    cardTitle("Cognia — Your open workspace for AI agents"),
    "Your open workspace for AI agents"
  )
})

test("cardTitle leaves an already-clean title alone", () => {
  assert.equal(cardTitle("Workflows"), "Workflows")
})

test("shotPaths names the matrix cell consistently on disk and in the manifest", () => {
  const { src, file } = shotPaths("hero", "dark", "zh")
  assert.equal(src, "/product/hero-dark-zh.png")
  assert.ok(file.endsWith("/public/product/hero-dark-zh.png"))
})

test("every product section declares selectors that must be visible first", () => {
  // The guard is the point: without it a moved UI yields a wrong screenshot
  // rather than a failed run.
  for (const section of SECTIONS) {
    assert.ok(section.requireVisible.length > 0, `${section.key} has no visibility guard`)
  }
})

test("the demo project is fictional, never the author's own repository", () => {
  assert.match(DEMO.repository, /^acme\//)
  assert.doesNotMatch(DEMO.repository, /cognia/i)
})

test("eyebrowFrom skips the metadata block and finds the page's own eyebrow", () => {
  // `product` appears under `meta` first, where there is no eyebrow at all.
  const source = [
    "  meta: {",
    "    product: {",
    '      title: "Product",',
    '      description: "…",',
    "    },",
    "  },",
    "  product: {",
    "    header: {",
    '      eyebrow: "Product",',
    '      title: "One workspace",',
    "    },",
    "  },",
  ].join("\n")
  assert.equal(eyebrowFrom(source, "product"), "Product")
})

test("eyebrowFrom returns null rather than a neighbour's eyebrow", () => {
  assert.equal(eyebrowFrom('  nothing: {\n    title: "x",\n  },', "nothing"), null)
})

test("every real copy module yields an eyebrow for every OG route", async () => {
  const { readFileSync } = await import("node:fs")
  const { fileURLToPath } = await import("node:url")
  const { dirname, join } = await import("node:path")
  const here = dirname(fileURLToPath(import.meta.url))

  for (const locale of ["en", "zh"]) {
    const source = readFileSync(join(here, "..", "content", `${locale}.ts`), "utf8")
    for (const entry of OG_ROUTES) {
      const eyebrow = eyebrowFrom(source, entry.eyebrowKey)
      assert.ok(eyebrow, `${locale}: no eyebrow for ${entry.eyebrowKey}`)
    }
  }
})

test("originFromEnv never falls back to a development host", () => {
  assert.equal(originFromEnv({}), "")
  assert.equal(
    originFromEnv({ NEXT_PUBLIC_WEB_SITE_URL: "https://cognia.example" }),
    "cognia.example"
  )
  assert.equal(originFromEnv({ WEB_SITE_URL: "cognia.example" }), "cognia.example")
  assert.equal(originFromEnv({ NEXT_PUBLIC_WEB_SITE_URL: "not a url" }), "")
})
