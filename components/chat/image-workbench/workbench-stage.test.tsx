import { render, screen } from "@testing-library/react"
import { fireEvent } from "@testing-library/dom"

import type { MaskStroke } from "@/lib/images"

import { WorkbenchStage, type WorkbenchStageProps } from "./workbench-stage"

/**
 * jsdom reports a zero-sized rect for everything, and the stage's whole job is
 * translating pointer positions through the letterbox that `object-contain`
 * creates. A stubbed rect is what makes that translation observable at all.
 */
function stubRect(width: number, height: number) {
  Element.prototype.getBoundingClientRect = jest.fn(
    () =>
      ({
        left: 0,
        top: 0,
        right: width,
        bottom: height,
        width,
        height,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect
  )
}

const originalRect = Element.prototype.getBoundingClientRect

afterEach(() => {
  Element.prototype.getBoundingClientRect = originalRect
})

function props(overrides: Partial<WorkbenchStageProps> = {}): WorkbenchStageProps {
  return {
    previewUrl: "blob:preview",
    originalUrl: "blob:original",
    size: { width: 400, height: 200 },
    zoom: 1,
    mode: "view",
    showOriginal: false,
    cropRect: null,
    onCropRectChange: jest.fn(),
    brush: { radius: 10, hardness: 1, mode: "add" },
    strokes: [],
    onStrokesChange: jest.fn(),
    ...overrides,
  }
}

describe("WorkbenchStage", () => {
  it("shows the current render", () => {
    render(<WorkbenchStage {...props()} />)
    expect(screen.getByTestId("workbench-preview")).toHaveAttribute("src", "blob:preview")
  })

  it("shows a skeleton until a render exists", () => {
    render(<WorkbenchStage {...props({ previewUrl: null })} />)
    expect(screen.queryByTestId("workbench-preview")).not.toBeInTheDocument()
  })

  it("swaps to the original while comparing, and says so", () => {
    render(<WorkbenchStage {...props({ showOriginal: true })} />)
    expect(screen.getByTestId("workbench-preview")).toHaveAttribute("src", "blob:original")
    expect(screen.getByTestId("workbench-compare-badge")).toBeInTheDocument()
  })

  it("falls back to the render when there is no original to compare against", () => {
    render(<WorkbenchStage {...props({ showOriginal: true, originalUrl: null })} />)
    expect(screen.getByTestId("workbench-preview")).toHaveAttribute("src", "blob:preview")
  })

  it("applies the zoom as a transform", () => {
    render(<WorkbenchStage {...props({ zoom: 2 })} />)
    expect(screen.getByTestId("workbench-preview")).toHaveStyle({ transform: "scale(2)" })
  })

  it("ignores pointer input while viewing", () => {
    stubRect(400, 200)
    const onCropRectChange = jest.fn()
    render(<WorkbenchStage {...props({ onCropRectChange })} />)
    fireEvent.pointerDown(screen.getByTestId("workbench-stage"), { clientX: 10, clientY: 10 })
    expect(onCropRectChange).not.toHaveBeenCalled()
  })

  it("starts a crop rect where the pointer went down", () => {
    // The stage is 400x200 and so is the image, so display and source
    // coordinates coincide here by construction.
    stubRect(400, 200)
    const onCropRectChange = jest.fn()
    render(<WorkbenchStage {...props({ mode: "crop", onCropRectChange })} />)
    fireEvent.pointerDown(screen.getByTestId("workbench-stage"), { clientX: 40, clientY: 20 })
    expect(onCropRectChange).toHaveBeenCalledWith({ x: 40, y: 20, width: 1, height: 1 })
  })

  it("converts a drag into a source-pixel rect through the display scale", () => {
    // Stage twice the image's size: a 100px drag on screen is 50 source pixels.
    stubRect(800, 400)
    const onCropRectChange = jest.fn()
    render(<WorkbenchStage {...props({ mode: "crop", onCropRectChange })} />)
    const stage = screen.getByTestId("workbench-stage")
    fireEvent.pointerDown(stage, { clientX: 0, clientY: 0 })
    fireEvent.pointerMove(stage, { clientX: 100, clientY: 100 })
    expect(onCropRectChange).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 50, height: 50 })
  })

  it("clamps a drag that leaves the picture", () => {
    stubRect(400, 200)
    const onCropRectChange = jest.fn()
    render(<WorkbenchStage {...props({ mode: "crop", onCropRectChange })} />)
    const stage = screen.getByTestId("workbench-stage")
    fireEvent.pointerDown(stage, { clientX: 380, clientY: 190 })
    fireEvent.pointerMove(stage, { clientX: 900, clientY: 900 })
    const rect = onCropRectChange.mock.calls.at(-1)![0]
    expect(rect.x + rect.width).toBeLessThanOrEqual(400)
    expect(rect.y + rect.height).toBeLessThanOrEqual(200)
  })

  it("draws the crop overlay for the current rect", () => {
    stubRect(400, 200)
    render(
      <WorkbenchStage
        {...props({ mode: "crop", cropRect: { x: 10, y: 10, width: 100, height: 50 } })}
      />
    )
    expect(screen.getByTestId("workbench-crop-overlay")).toBeInTheDocument()
  })

  it("appends a stroke on pointer down in brush mode and extends it on move", () => {
    stubRect(400, 200)
    const onStrokesChange = jest.fn()
    const { rerender } = render(<WorkbenchStage {...props({ mode: "brush", onStrokesChange })} />)
    const stage = screen.getByTestId("workbench-stage")
    fireEvent.pointerDown(stage, { clientX: 20, clientY: 20 })

    const started = onStrokesChange.mock.calls[0][0] as MaskStroke[]
    expect(started).toHaveLength(1)
    expect(started[0]).toMatchObject({ mode: "add", radius: 10, points: [{ x: 20, y: 20 }] })

    rerender(<WorkbenchStage {...props({ mode: "brush", onStrokesChange, strokes: started })} />)
    fireEvent.pointerMove(stage, { clientX: 30, clientY: 25 })
    const extended = onStrokesChange.mock.calls.at(-1)![0] as MaskStroke[]
    expect(extended).toHaveLength(1)
    expect(extended[0].points).toHaveLength(2)
  })

  it("draws the painted strokes as an overlay", () => {
    stubRect(400, 200)
    render(
      <WorkbenchStage
        {...props({
          mode: "brush",
          strokes: [
            {
              mode: "add",
              radius: 10,
              hardness: 1,
              points: [
                { x: 0, y: 0 },
                { x: 10, y: 10 },
              ],
            },
          ],
        })}
      />
    )
    expect(screen.getByTestId("workbench-brush-overlay")).toBeInTheDocument()
  })

  it("stops extending a stroke once the pointer is released", () => {
    stubRect(400, 200)
    const onStrokesChange = jest.fn()
    render(<WorkbenchStage {...props({ mode: "brush", onStrokesChange })} />)
    const stage = screen.getByTestId("workbench-stage")
    fireEvent.pointerDown(stage, { clientX: 20, clientY: 20 })
    fireEvent.pointerUp(stage)
    onStrokesChange.mockClear()
    fireEvent.pointerMove(stage, { clientX: 60, clientY: 60 })
    expect(onStrokesChange).not.toHaveBeenCalled()
  })
})
