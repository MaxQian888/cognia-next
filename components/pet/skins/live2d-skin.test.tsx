import { act, render, screen, waitFor } from "@testing-library/react"
import type { PetBones, PetStage } from "@/types/pet"
import { getPetSkinRuntime, resetPetSkinRuntimeForTests } from "@/lib/pet/skin-runtime"

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

import { live2dSkin } from "./live2d-skin"

const baseProps = {
  bones: {} as PetBones,
  stage: "baby" as PetStage,
  state: "idle" as const,
  oneShot: null,
  reducedMotion: false,
  size: 96,
  selection: { skinId: "live2d", modelId: "m1" } as const,
}

beforeEach(() => {
  resetPetSkinRuntimeForTests()
  canvasShouldThrow = false
  canvasErrorCode = null
  canvasProps.mockClear()
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
    const { container } = render(
      <>{live2dSkin.render({ ...baseProps, selection: { skinId: "svg" } })}</>
    )
    expect(container.querySelector('[data-pet-skin-root="svg"]')).not.toBeNull()
    expect(screen.queryByTestId("live2d-canvas")).toBeNull()
  })

  it("forwards governed render props to the canvas", async () => {
    const lookTarget = { x: 0.4, y: -0.2, updatedAt: 1, source: "window" as const }
    render(
      <>
        {live2dSkin.render({
          ...baseProps,
          lowPower: true,
          speaking: true,
          held: true,
          mood: "lonely",
          flavor: "radiant",
          lookTarget,
        })}
      </>
    )
    await waitFor(() =>
      expect(canvasProps).toHaveBeenCalledWith(
        expect.objectContaining({
          modelId: "m1",
          lowPower: true,
          speaking: true,
          paused: true,
          lookTarget,
        })
      )
    )
    expect(screen.getByTestId("live2d-canvas").parentElement).toHaveAttribute(
      "data-pet-held",
      "true"
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
    rerender(
      <>{live2dSkin.render({ ...baseProps, selection: { skinId: "live2d", modelId: "m2" } })}</>
    )
    await waitFor(() => expect(screen.getByTestId("live2d-canvas")).toHaveTextContent("m2"))
  })

  it("remounts a degraded canvas after a user-triggered runtime retry", async () => {
    canvasErrorCode = "modelFailed"
    const { container } = render(<>{live2dSkin.render(baseProps)}</>)
    await waitFor(() =>
      expect(container.querySelector('[data-pet-skin-root="svg"]')).not.toBeNull()
    )

    canvasErrorCode = null
    act(() => getPetSkinRuntime().retryAsset("live2d:m1"))
    await waitFor(() => expect(screen.getByTestId("live2d-canvas")).toHaveTextContent("m1"))
  })
})
