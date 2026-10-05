import { describe, expect, it } from "vitest"

import { PAGE_ICONS, PAGE_ICONS_SOURCE } from "./page-icons"

describe("page icons", () => {
  it("is a small WebP data URI per outcome, each from the app's spot icon set", () => {
    for (const [key, uri] of Object.entries(PAGE_ICONS)) {
      expect(uri.startsWith("data:image/webp;base64,")).toBe(true)
      const bytes = Uint8Array.from(atob(uri.slice(uri.indexOf(",") + 1)), (c) => c.charCodeAt(0))
      const text = String.fromCharCode(...bytes.slice(0, 4), ...bytes.slice(8, 12))
      expect(text).toBe("RIFFWEBP")
      // Inlined into every page: stay a downscaled copy, not the 512 px original.
      expect(bytes.length).toBeLessThan(40_000)
      expect(PAGE_ICONS_SOURCE[key as keyof typeof PAGE_ICONS]).toMatch(/^[a-z-]+$/)
    }
  })

  it("draws success and failure from different icons", () => {
    expect(PAGE_ICONS.done).not.toBe(PAGE_ICONS.failed)
    expect(PAGE_ICONS_SOURCE).toMatchObject({ welcome: "cloud-account", failed: "diagnostics" })
  })
})
