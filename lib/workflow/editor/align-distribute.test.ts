import { computeAlign, computeDistribute, type NodeRect } from "./align-distribute"

const rects: NodeRect[] = [
  { id: "a", x: 0, y: 0, width: 100, height: 40 },
  { id: "b", x: 50, y: 100, width: 60, height: 80 },
  { id: "c", x: 200, y: 300, width: 40, height: 20 },
]

describe("computeAlign", () => {
  it("returns an empty map for fewer than two rects", () => {
    expect(computeAlign([rects[0]!], "left")).toEqual({})
  })

  it("aligns left edges to the bounding-box left", () => {
    const out = computeAlign(rects, "left")
    expect(out.a!.x).toBe(0)
    expect(out.b!.x).toBe(0)
    expect(out.c!.x).toBe(0)
    // y is untouched for horizontal alignment.
    expect(out.b!.y).toBe(100)
  })

  it("aligns right edges to the bounding-box right", () => {
    const out = computeAlign(rects, "right")
    const maxRight = 240 // c: 200 + 40
    expect(out.a!.x).toBe(maxRight - 100)
    expect(out.b!.x).toBe(maxRight - 60)
    expect(out.c!.x).toBe(maxRight - 40)
  })

  it("centres horizontally on the bounding-box centre", () => {
    const out = computeAlign(rects, "centerH")
    const centerX = (0 + 240) / 2 // 120
    expect(out.a!.x).toBe(centerX - 50)
    expect(out.c!.x).toBe(centerX - 20)
  })

  it("aligns top / bottom / centerV on the vertical axis", () => {
    expect(computeAlign(rects, "top").a!.y).toBe(0)
    const maxBottom = 320 // c: 300 + 20
    expect(computeAlign(rects, "bottom").a!.y).toBe(maxBottom - 40)
    const centerY = (0 + 320) / 2 // 160
    expect(computeAlign(rects, "centerV").a!.y).toBe(centerY - 20)
    // x untouched for vertical alignment.
    expect(computeAlign(rects, "top").b!.x).toBe(50)
  })
})

describe("computeDistribute", () => {
  it("returns an empty map for fewer than three rects", () => {
    expect(computeDistribute(rects.slice(0, 2), "horizontal")).toEqual({})
  })

  it("keeps the extreme rects fixed and equalises horizontal gaps", () => {
    const out = computeDistribute(rects, "horizontal")
    // First and last keep their original x.
    expect(out.a!.x).toBe(0)
    expect(out.c!.x).toBe(200)
    // Equal gaps: span 240, totalWidth 200 → gap 20 over 2 intervals.
    // a ends at 100, +gap 20 → b at 120.
    expect(out.b!.x).toBe(120)
  })

  it("keeps the extreme rects fixed and equalises vertical gaps", () => {
    const out = computeDistribute(rects, "vertical")
    expect(out.a!.y).toBe(0)
    expect(out.c!.y).toBe(300)
    // span 320, totalHeight 140 → gap 90 over 2 intervals. a ends at 40, +90 → b at 130.
    expect(out.b!.y).toBe(130)
    expect(out.b!.x).toBe(50) // x untouched
  })
})
