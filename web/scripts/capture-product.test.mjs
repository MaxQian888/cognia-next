import assert from "node:assert/strict"
import test from "node:test"

import { mergeShotManifest, parseArgs } from "./capture-product.mjs"

const OLD_HERO_LIGHT_EN = {
  src: "/product/hero-light-en.png",
  width: 2880,
  height: 1800,
}
const OLD_HERO_DARK_EN = {
  src: "/product/hero-dark-en.png",
  width: 2880,
  height: 1800,
}
const OLD_WORKBENCH_LIGHT_ZH = {
  src: "/product/workbench-light-zh.png",
  width: 2880,
  height: 1800,
}

test("capture filters accept a single section, locale, and theme", () => {
  assert.deepEqual(parseArgs(["--only", "hero", "--locale", "zh", "--theme", "dark"]), {
    baseUrl: "http://localhost:4173",
    only: "hero",
    locale: "zh",
    theme: "dark",
  })
})

test("a filtered capture replaces selected cells and preserves the rest of the manifest", () => {
  const existing = {
    capturedAt: "2026-07-25T00:00:00.000Z",
    shots: {
      "hero-light-en": OLD_HERO_LIGHT_EN,
      "hero-dark-en": OLD_HERO_DARK_EN,
      "workbench-light-zh": OLD_WORKBENCH_LIGHT_ZH,
    },
  }
  const replacement = {
    src: "/product/hero-light-en.png",
    width: 1920,
    height: 1200,
  }

  const merged = mergeShotManifest(
    existing,
    ["hero-light-en"],
    { "hero-light-en": replacement },
    "2026-07-26T00:00:00.000Z"
  )

  assert.deepEqual(merged, {
    capturedAt: "2026-07-26T00:00:00.000Z",
    shots: {
      "hero-light-en": replacement,
      "hero-dark-en": OLD_HERO_DARK_EN,
      "workbench-light-zh": OLD_WORKBENCH_LIGHT_ZH,
    },
  })
  assert.deepEqual(existing.shots["hero-light-en"], OLD_HERO_LIGHT_EN)
})

test("a failed selected recapture removes its stale manifest cell without touching other cells", () => {
  const merged = mergeShotManifest(
    {
      capturedAt: "2026-07-25T00:00:00.000Z",
      shots: {
        "hero-light-en": OLD_HERO_LIGHT_EN,
        "hero-dark-en": OLD_HERO_DARK_EN,
      },
    },
    ["hero-light-en"],
    {},
    "2026-07-26T00:00:00.000Z"
  )

  assert.deepEqual(merged.shots, {
    "hero-dark-en": OLD_HERO_DARK_EN,
  })
})
