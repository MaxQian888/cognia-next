import { computePictureInPictureAnchors } from "./picture-in-picture-layout"

describe("computePictureInPictureAnchors", () => {
  it("places a 250px surface at all four 24px-inset corners", () => {
    const anchors = computePictureInPictureAnchors({ x: 0, y: 0, width: 1000, height: 800 }, [])

    expect(anchors).toEqual({
      topLeft: { x: 24, y: 24 },
      topRight: { x: 726, y: 24 },
      bottomLeft: { x: 24, y: 526 },
      bottomRight: { x: 726, y: 526 },
    })
  })

  it("moves a bottom anchor above an overlapping footer with 12px clearance", () => {
    const anchors = computePictureInPictureAnchors({ x: 0, y: 0, width: 1000, height: 800 }, [
      { x: 650, y: 600, width: 350, height: 200 },
    ])

    expect(anchors.bottomRight.y).toBe(338)
    expect(anchors.bottomRight.x).toBe(726)
  })

  it("keeps anchors inside small hosts", () => {
    const anchors = computePictureInPictureAnchors({ x: 10, y: 20, width: 220, height: 180 }, [], {
      width: 160,
      height: 120,
    })

    for (const anchor of Object.values(anchors)) {
      expect(anchor.x).toBeGreaterThanOrEqual(34)
      expect(anchor.y).toBeGreaterThanOrEqual(44)
      expect(anchor.x + 160).toBeLessThanOrEqual(206)
      expect(anchor.y + 120).toBeLessThanOrEqual(176)
    }
  })

  it("chooses the lowest-overlap route across multiple obstacles", () => {
    const anchors = computePictureInPictureAnchors({ x: 0, y: 0, width: 1000, height: 800 }, [
      { x: 700, y: 500, width: 300, height: 300 },
      { x: 400, y: 500, width: 250, height: 300 },
    ])

    expect(anchors.bottomRight.y).toBeLessThan(500)
    expect(anchors.bottomRight.x).toBeGreaterThanOrEqual(24)
  })

  it("terminates when a full-host obstacle leaves no collision-free position", () => {
    const anchors = computePictureInPictureAnchors({ x: 0, y: 0, width: 400, height: 400 }, [
      { x: 0, y: 0, width: 400, height: 400 },
    ])

    expect(anchors.topLeft).toEqual({ x: 24, y: 24 })
    expect(anchors.bottomRight).toEqual({ x: 126, y: 126 })
  })
})
