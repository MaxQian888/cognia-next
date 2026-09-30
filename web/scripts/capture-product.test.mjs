import assert from "node:assert/strict"
import test from "node:test"

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  JUMP_TO_LATEST_SELECTOR,
  SECTIONS,
  mergeShotManifest,
  parseArgs,
} from "./capture-product.mjs"
import { CHAT_SURFACE_SELECTOR } from "./demo-session.mjs"

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

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const productSource = (path) => readFileSync(join(REPO, path), "utf8")

test("the matrix is hero, workbench and desktop, each waiting on the chat surface", () => {
  assert.deepEqual(
    SECTIONS.map((section) => section.key),
    ["hero", "workbench", "desktop"]
  )
  for (const section of SECTIONS) {
    assert.equal(section.requireVisible[0], CHAT_SURFACE_SELECTOR, section.key)
    // Sections no longer navigate on their own: the staged session is opened once per cell.
    assert.ok(!("route" in section), `${section.key} has no route`)
  }
  assert.ok(
    SECTIONS.find((s) => s.key === "workbench").requireVisible.includes(
      '[data-testid="artifact-workspace-dock"]'
    )
  )
  assert.deepEqual(SECTIONS.find((s) => s.key === "desktop").clip, {
    x: 0,
    y: 0,
    width: 960,
    height: 600,
  })
  assert.equal(SECTIONS.find((s) => s.key === "hero").clip, null)
})

test("every selector the capture waits on still exists in the product", () => {
  // A renamed test id in the app would otherwise surface as a capture that times out.
  assert.match(productSource("components/chat/chat-view.tsx"), /data-slot="chat-surface-stage"/)
  assert.equal(CHAT_SURFACE_SELECTOR, '[data-slot="chat-surface-stage"]')
  assert.match(
    productSource("components/artifacts/artifact-workspace-dock.tsx"),
    /data-testid="artifact-workspace-dock"/
  )
  assert.equal(JUMP_TO_LATEST_SELECTOR, '[data-testid="conversation-jump-pill"]')
  assert.match(
    productSource("components/chat/conversation-jump-pill.tsx"),
    /data-testid="conversation-jump-pill"/
  )
})
