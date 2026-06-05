import { render, screen, waitFor } from "@testing-library/react"
import type { PetBones, PetStage } from "@/types/pet"

// The lazy canvas is replaced with a probe that can optionally throw to drive
// the error boundary. A thrown error in the lazy child is caught by the
// boundary and degrades to the SVG fallback.
let canvasShouldThrow = false
const canvasProps = jest.fn()
jest.mock("./live2d/live2d-canvas", () => ({
  __esModule: true,
  default: (props: { modelId: string }) => {
    if (canvasShouldThrow) throw new Error("boom")
    canvasProps(props)
    return <div data-testid="live2d-canvas">{props.modelId}</div>
  },
}))

// The SVG skin needs a fully-populated bones object; here we only care that the
// fallback path renders, so stub it with the same root marker the real one uses.
jest.mock("./svg-skin", () => ({
  svgSkin: { id: "svg", render: () => <div data-pet-skin-root="svg" /> },
}))

let activeModelId: string | undefined
let activeRow: unknown
jest.mock("@/hooks/pet/use-active-live2d-model", () => ({
  useActiveLive2dModel: () => ({ modelId: activeModelId, row: activeRow, coreReady: true }),
}))

let settingsNull = false
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({
      settings: settingsNull
        ? null
        : { petSettings: { skinId: "live2d", activeLive2dModelId: activeModelId } },
    }),
}))

import { live2dSkin } from "./live2d-skin"

const baseProps = {
  bones: {} as PetBones,
  stage: "baby" as PetStage,
  state: "idle" as const,
  oneShot: null,
  reducedMotion: false,
  size: 96,
}

beforeEach(() => {
  canvasShouldThrow = false
  canvasProps.mockClear()
  activeModelId = "m1"
  activeRow = undefined
  settingsNull = false
})

describe("live2dSkin", () => {
  it("has the live2d id", () => {
    expect(live2dSkin.id).toBe("live2d")
  })

  it("renders the lazy canvas when an active model exists", async () => {
    render(<>{live2dSkin.render(baseProps)}</>)
    await waitFor(() => expect(screen.getByTestId("live2d-canvas")).toHaveTextContent("m1"))
  })

  it("renders the SVG fallback when there is no active model", () => {
    activeModelId = undefined
    const { container } = render(<>{live2dSkin.render(baseProps)}</>)
    expect(container.querySelector('[data-pet-skin-root="svg"]')).not.toBeNull()
    expect(screen.queryByTestId("live2d-canvas")).toBeNull()
  })

  it("falls back to default settings when the settings store is empty", async () => {
    settingsNull = true
    activeModelId = "m1"
    render(<>{live2dSkin.render(baseProps)}</>)
    await waitFor(() => expect(screen.getByTestId("live2d-canvas")).toBeInTheDocument())
  })

  it("passes the row's normalized customization to the canvas", async () => {
    activeRow = {
      id: "m1",
      transform: { scale: 9, offsetX: 0.1 }, // out of range → clamped on read
      motionOverrides: { happy: { motionGroup: "Tap" } },
    }
    render(<>{live2dSkin.render(baseProps)}</>)
    await waitFor(() =>
      expect(canvasProps).toHaveBeenCalledWith(
        expect.objectContaining({
          transform: { scale: 2, offsetX: 0.1, offsetY: 0 },
          motionOverrides: { happy: { motionGroup: "Tap" } },
        })
      )
    )
  })

  it("defaults the transform when the row has no customization", async () => {
    render(<>{live2dSkin.render(baseProps)}</>)
    await waitFor(() =>
      expect(canvasProps).toHaveBeenCalledWith(
        expect.objectContaining({
          transform: { scale: 1, offsetX: 0, offsetY: 0 },
          motionOverrides: undefined,
        })
      )
    )
  })

  it("degrades to the SVG fallback when the canvas throws", async () => {
    canvasShouldThrow = true
    // Silence the expected React error-boundary console noise.
    const spy = jest.spyOn(console, "error").mockImplementation(() => {})
    const { container } = render(<>{live2dSkin.render(baseProps)}</>)
    await waitFor(() =>
      expect(container.querySelector('[data-pet-skin-root="svg"]')).not.toBeNull()
    )
    spy.mockRestore()
  })
})
