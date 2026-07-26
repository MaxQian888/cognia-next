import test from "node:test"
import assert from "node:assert/strict"

import {
  extractInternalLinks,
  metaPageRefs,
  normalizeLink,
  urlsForContentPath,
} from "./check-docs-links.mjs"

test("urlsForContentPath maps a localized page to its single URL", () => {
  assert.deepEqual(urlsForContentPath("en/subsystems/ocr/cache.mdx"), [
    "/en/docs/subsystems/ocr/cache",
  ])
})

test("urlsForContentPath folds index pages into the folder URL", () => {
  assert.deepEqual(urlsForContentPath("en/subsystems/ocr/index.mdx"), ["/en/docs/subsystems/ocr"])
  assert.deepEqual(urlsForContentPath("zh/index.mdx"), ["/zh/docs"])
})

test("urlsForContentPath expands locale-shared pages onto every prefix", () => {
  // `content/docs/plugin-dev/` has no locale segment and answers on both.
  assert.deepEqual(urlsForContentPath("plugin-dev/manifest.mdx"), [
    "/en/docs/plugin-dev/manifest",
    "/zh/docs/plugin-dev/manifest",
  ])
})

test("urlsForContentPath handles .md as well as .mdx", () => {
  assert.deepEqual(urlsForContentPath("zh/adr/0011-workflows-subsystem.md"), [
    "/zh/docs/adr/0011-workflows-subsystem",
  ])
})

test("normalizeLink drops fragments, queries and trailing slashes", () => {
  assert.equal(normalizeLink("/en/docs/core/architecture#layers"), "/en/docs/core/architecture")
  assert.equal(normalizeLink("/en/docs/core/architecture/"), "/en/docs/core/architecture")
  assert.equal(normalizeLink("/en/docs?x=1"), "/en/docs")
})

test("extractInternalLinks finds Markdown and JSX links, ignoring external ones", () => {
  const source = [
    "See [architecture](/en/docs/core/architecture).",
    '<a href="/zh/docs/getting-started">开始</a>',
    "[external](https://example.com/page)",
    "[protocol-relative](//example.com/page)",
    "[relative](./sibling)",
  ].join("\n")

  assert.deepEqual(extractInternalLinks(source).sort(), [
    "/en/docs/core/architecture",
    "/zh/docs/getting-started",
  ])
})

test("metaPageRefs keeps file rows and drops separators, links and rest operators", () => {
  assert.deepEqual(
    metaPageRefs([
      "---Getting started---",
      "index",
      "getting-started",
      "[ADR-0058 (EN)](/en/docs/adr/0058-desktop-pet-subsystem)",
      "external:[Repo](https://github.com/x/y)",
      "...",
      "z...a",
      "!excluded",
    ]),
    ["index", "getting-started"]
  )
})
