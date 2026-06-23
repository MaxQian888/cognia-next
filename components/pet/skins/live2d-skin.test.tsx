import { render, screen, waitFor } from "@testing-library/react"
import type { PetBones, PetStage } from "@/types/pet"

// The lazy canvas is replaced with a probe that can optionally throw (sync error
// boundary path) or report a typed code through `onError` (async load-failure
// path). Either degrades to the SVG fallback.
let canvasShouldThrow = false
let canvasErrorCode: string | null = null
const canvasProps = jest.fn()
jest.mock("./live2d/live2d-canvas", () => {
  const ReactActual = jest.requireActual("react") as typeof import("react")
  function MockLive2dCanvas(props: { modelId: string; onError?: (code: string) => void }) {
    // Fire onError asynchronously like the real canvas (it reports only after
    // awaiting the DB row + engine init), so it never races the boundary's
    // mount-time reset effect.
    ReactActual.useEffect(() => {
      if (!canvasErrorCode) return
      const id = setTimeout(() => props.onError?.(canvasErrorCode!), 0)
      return () => clearTimeout(id)
    }, [props])
    if (canvasShouldThrow) throw new Error("boom")
    canvasProps(props)
    return <div data-testid="live2d-canvas">{props.modelId}</div>
  }
  return { __esModule: true, default: MockLive2dCanvas }
})

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
import { usePetStore } from "@/stores/pet/pet-store"

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
  canvasErrorCode = null
  canvasProps.mockClear()
  activeModelId = "m1"
  activeRow = undefined
  settingsNull = false
  usePetStore.setState({ bubble: null })
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

  it("tells the canvas it is speaking only while a bubble is showing", async () => {
    // No bubble → not speaking.
    render(<>{live2dSkin.render(baseProps)}</>)
    await waitFor(() =>
      expect(canvasProps).toHaveBeenCalledWith(expect.objectContaining({ speaking: false }))
    )

    // A visible bubble flips the lip-sync `speaking` flag on the canvas.
    canvasProps.mockClear()
    usePetStore.setState({ bubble: { text: "hi!", origin: "llm" } })
    render(<>{live2dSkin.render(baseProps)}</>)
    await waitFor(() =>
      expect(canvasProps).toHaveBeenCalledWith(expect.objectContaining({ speaking: true }))
    )
  })

  it("degrades to the SVG fallback when the canvas reports an async load error", async () => {
    canvasErrorCode = "modelFailed"
    const { container } = render(<>{live2dSkin.render(baseProps)}</>)
    await waitFor(() => {
      expect(container.querySelector('[data-pet-skin-root="svg"]')).not.toBeNull()
      expect(screen.queryByTestId("live2d-canvas")).toBeNull()
    })
  })

  it("retries the canvas after switching to a different model", async () => {
    canvasErrorCode = "modelFailed"
    const { rerender, container } = render(<>{live2dSkin.render(baseProps)}</>)
    await waitFor(() =>
      expect(container.querySelector('[data-pet-skin-root="svg"]')).not.toBeNull()
    )
    // A new model clears the failure flag and mounts the canvas again.
    canvasErrorCode = null
    activeModelId = "m2"
    rerender(<>{live2dSkin.render(baseProps)}</>)
    await waitFor(() => expect(screen.getByTestId("live2d-canvas")).toHaveTextContent("m2"))
  })
})
