import { resolveCapabilities, shellHasImageSource } from "./capabilities"

const caps = (
  shell: Parameters<typeof resolveCapabilities>[0]["shell"],
  ocrReady = true,
  hasImageSource = true
) => resolveCapabilities({ shell, ocrReady, hasImageSource })

describe("resolveCapabilities", () => {
  it("gives the desktop everything when OCR is reachable", () => {
    expect(caps("tauri")).toEqual(["fs", "ocr", "web"])
  })

  it("never grants fs off the desktop", () => {
    expect(caps("web")).not.toContain("fs")
    expect(caps("mobile-standalone")).not.toContain("fs")
    expect(caps("mobile-paired")).not.toContain("fs")
  })

  it("withholds ocr when no provider is reachable", () => {
    // Offering a card that fails after the user picks it is worse than not
    // offering it.
    expect(caps("tauri", false, true)).toEqual(["fs", "web"])
  })

  it("withholds ocr when there is no image source", () => {
    expect(caps("tauri", true, false)).toEqual(["fs", "web"])
  })

  it("always grants web — the reader runs everywhere", () => {
    for (const shell of ["tauri", "web", "mobile-standalone", "mobile-paired"] as const) {
      expect(resolveCapabilities({ shell, ocrReady: false, hasImageSource: false })).toContain(
        "web"
      )
    }
  })

  it("leaves a paired phone with web alone", () => {
    expect(caps("mobile-paired", true, false)).toEqual(["web"])
  })
})

describe("shellHasImageSource", () => {
  it("is true where a screenshot or camera exists locally", () => {
    expect(shellHasImageSource("tauri")).toBe(true)
    expect(shellHasImageSource("mobile-standalone")).toBe(true)
  })

  it("is false in a browser", () => {
    expect(shellHasImageSource("web")).toBe(false)
  })

  it("is false on a paired phone — the screen that matters is the desktop's", () => {
    expect(shellHasImageSource("mobile-paired")).toBe(false)
  })
})
