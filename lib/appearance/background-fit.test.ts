import {
  BG_VARS,
  FOCAL_PRESETS,
  WALLPAPER_POSITIONS,
  backgroundFitStyle,
  clampFocal,
  focalPresetId,
  resolveBackgroundFit,
  supportsFocalPoint,
} from "./background-fit"

describe("resolveBackgroundFit", () => {
  it("maps each fit to its CSS size and repeat", () => {
    expect(resolveBackgroundFit("cover")).toMatchObject({ size: "cover", repeat: "no-repeat" })
    expect(resolveBackgroundFit("contain")).toMatchObject({ size: "contain", repeat: "no-repeat" })
    expect(resolveBackgroundFit("fill")).toMatchObject({ size: "100% 100%", repeat: "no-repeat" })
    expect(resolveBackgroundFit("center")).toMatchObject({ size: "auto", repeat: "no-repeat" })
    expect(resolveBackgroundFit("tile")).toMatchObject({ size: "auto", repeat: "repeat" })
  })

  it("anchors focal-aware fits at the requested point", () => {
    expect(resolveBackgroundFit("cover", 0, 100).position).toBe("0% 100%")
    expect(resolveBackgroundFit("contain", 25, 75).position).toBe("25% 75%")
    expect(resolveBackgroundFit("center", 100, 0).position).toBe("100% 0%")
  })

  // A stale focal point from a previous fit must not leak into a fit that
  // cannot honour it — the image would look randomly offset.
  it("pins non-focal fits to center regardless of the stored focal point", () => {
    expect(resolveBackgroundFit("fill", 0, 100).position).toBe("center")
    expect(resolveBackgroundFit("tile", 0, 100).position).toBe("center")
  })

  it("defaults an unset focal point to the middle", () => {
    expect(resolveBackgroundFit("cover").position).toBe("50% 50%")
  })

  it("covers every position the UI offers", () => {
    for (const position of WALLPAPER_POSITIONS) {
      const fit = resolveBackgroundFit(position, 10, 90)
      expect(fit.size).not.toBe("")
      expect(fit.repeat).not.toBe("")
      expect(fit.position).not.toBe("")
    }
  })
})

describe("supportsFocalPoint", () => {
  it("is true only for the fits that leave the image room to move", () => {
    expect(supportsFocalPoint("cover")).toBe(true)
    expect(supportsFocalPoint("contain")).toBe(true)
    expect(supportsFocalPoint("center")).toBe(true)
    expect(supportsFocalPoint("fill")).toBe(false)
    expect(supportsFocalPoint("tile")).toBe(false)
  })
})

describe("clampFocal", () => {
  it("clamps into 0..100 and rounds", () => {
    expect(clampFocal(-20)).toBe(0)
    expect(clampFocal(140)).toBe(100)
    expect(clampFocal(33.6)).toBe(34)
  })

  it("falls back to center for missing or non-finite input", () => {
    expect(clampFocal(undefined)).toBe(50)
    expect(clampFocal(Number.NaN)).toBe(50)
    expect(clampFocal(Number.POSITIVE_INFINITY)).toBe(50)
  })
})

describe("focalPresetId", () => {
  it("names the preset a focal point sits exactly on", () => {
    expect(focalPresetId(50, 50)).toBe("center")
    expect(focalPresetId(0, 0)).toBe("topLeft")
    expect(focalPresetId(100, 100)).toBe("bottomRight")
  })

  it("returns null for a point between presets rather than snapping", () => {
    expect(focalPresetId(30, 50)).toBeNull()
  })

  it("exposes nine presets, one per cell of a 3x3 grid", () => {
    expect(FOCAL_PRESETS).toHaveLength(9)
    expect(new Set(FOCAL_PRESETS.map((p) => `${p.x}:${p.y}`)).size).toBe(9)
  })
})

describe("backgroundFitStyle", () => {
  it("mirrors resolveBackgroundFit in React style keys", () => {
    expect(backgroundFitStyle("contain", 10, 20)).toEqual({
      backgroundSize: "contain",
      backgroundRepeat: "no-repeat",
      backgroundPosition: "10% 20%",
    })
  })
})

describe("BG_VARS", () => {
  it("names the custom properties globals.css reads", () => {
    expect(BG_VARS).toEqual({
      image: "--app-bg-image",
      blur: "--app-bg-blur",
      opacity: "--app-bg-opacity",
      position: "--app-bg-position",
      size: "--app-bg-size",
      repeat: "--app-bg-repeat",
    })
  })
})
