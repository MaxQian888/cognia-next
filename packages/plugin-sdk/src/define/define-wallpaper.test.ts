import { defineWallpaper } from "./define-wallpaper"

describe("defineWallpaper", () => {
  it("returns a gradient wallpaper unchanged (pure pass-through)", () => {
    const w = defineWallpaper({
      id: "demo-aurora",
      name: "Aurora",
      source: { kind: "gradient", css: "linear-gradient(180deg, #1e3a 0%, #0f17 100%)" },
    })
    expect(w).toEqual({
      id: "demo-aurora",
      name: "Aurora",
      source: { kind: "gradient", css: "linear-gradient(180deg, #1e3a 0%, #0f17 100%)" },
    })
  })

  it("preserves the image source variant", () => {
    const w = defineWallpaper({
      id: "photo",
      name: "Photo",
      source: {
        kind: "image",
        relPath: "assets/wp.jpg",
        mime: "image/jpeg",
        width: 1920,
        height: 1080,
      },
    })
    expect(w.source).toMatchObject({ kind: "image", relPath: "assets/wp.jpg" })
  })
})
