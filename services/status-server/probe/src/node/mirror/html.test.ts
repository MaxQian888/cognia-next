import { describe, expect, it } from "vitest"

import { parseStatusRuntimeMeta } from "../../../../../../lib/status/config"
import { injectRuntimeMeta, MIRROR_RUNTIME_CONTENT } from "./html"

function metaContents(html: string): string[] {
  return [...html.matchAll(/<meta name="cognia-status-runtime" content='([^']*)'>/g)].map(
    (match) => match[1]!
  )
}

describe("injectRuntimeMeta", () => {
  it("declares mirror mode with the same-origin API, as the page parser expects", () => {
    expect(parseStatusRuntimeMeta(MIRROR_RUNTIME_CONTENT)).toEqual({
      mode: "mirror",
      apiBase: "/api/status/v1",
    })
  })

  it("inserts the tag at the top of <head>", () => {
    const out = injectRuntimeMeta(
      '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>x</title></head></html>'
    )
    expect(out).toBe(
      `<!DOCTYPE html><html lang="en"><head><meta name="cognia-status-runtime" content='${MIRROR_RUNTIME_CONTENT}'><meta charset="utf-8"><title>x</title></head></html>`
    )
  })

  it("replaces an existing primary tag (and collapses duplicates)", () => {
    const html =
      `<html><head><meta name="cognia-status-runtime" content='{"mode":"primary","apiBase":"/api/status/v1"}'/>` +
      `<meta content="x" name=cognia-status-runtime></head></html>`
    const out = injectRuntimeMeta(html)
    expect(metaContents(out)).toEqual([MIRROR_RUNTIME_CONTENT])
    expect(out).not.toContain("primary")
  })

  it("handles head tags with attributes and documents without <head>", () => {
    expect(metaContents(injectRuntimeMeta('<html><head data-x="1"></head></html>'))).toHaveLength(1)
    const bare = injectRuntimeMeta("<!doctype html><body>hi</body>")
    expect(bare.startsWith("<!doctype html><head><meta name=")).toBe(true)
  })

  it("is idempotent", () => {
    const once = injectRuntimeMeta("<html><head></head></html>")
    expect(injectRuntimeMeta(once)).toBe(once)
  })
})
