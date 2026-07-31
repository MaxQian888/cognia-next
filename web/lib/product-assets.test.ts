jest.mock("@web/content/generated/product-shots.json", () => ({
  capturedAt: "2026-07-26T00:00:00.000Z",
  shots: {
    "hero-light-en": { src: "/product/hero-light-en.png", width: 2400, height: 1500 },
    "hero-dark-en": { src: "/product/hero-dark-en.png", width: 2400, height: 1500 },
    "hero-light-zh": { src: "/product/hero-light-zh.png", width: 2400, height: 1500 },
    // `hero-dark-zh` is deliberately absent: a half-captured pair must not
    // resolve, or the Chinese dark page would show the light capture.
    "desktop-light-en": { src: "/product/desktop-light-en.png", width: 1600, height: 1000 },
  },
}))

import { capturedAt, findShot, findShotPair, shotKey } from "./product-assets"

describe("shotKey", () => {
  it("keys by section, theme and locale", () => {
    expect(shotKey("hero", "dark", "zh")).toBe("hero-dark-zh")
  })
})

describe("findShot", () => {
  it("returns a captured image", () => {
    expect(findShot("hero", "light", "en")).toEqual({
      src: "/product/hero-light-en.png",
      width: 2400,
      height: 1500,
    })
  })

  it("returns null for an uncaptured combination rather than a wrong image", () => {
    expect(findShot("hero", "dark", "zh")).toBeNull()
    expect(findShot("workbench", "light", "en")).toBeNull()
  })
})

describe("findShotPair", () => {
  it("returns both themes when both were captured", () => {
    const pair = findShotPair("hero", "en")
    expect(pair?.light.src).toBe("/product/hero-light-en.png")
    expect(pair?.dark.src).toBe("/product/hero-dark-en.png")
  })

  it("returns null when only one theme exists — never substitutes the other", () => {
    expect(findShotPair("hero", "zh")).toBeNull()
    expect(findShotPair("desktop", "en")).toBeNull()
  })

  it("returns null for a section that has not been captured at all", () => {
    expect(findShotPair("workbench", "en")).toBeNull()
  })
})

describe("capturedAt", () => {
  it("reports when the committed matrix was produced", () => {
    expect(capturedAt()).toBe("2026-07-26T00:00:00.000Z")
  })
})
