/**
 * @jest-environment jsdom
 */

import { act, render } from "@testing-library/react"
import { CanvasSimulationRichOutput } from "./canvas-simulation-rich-output"

describe("CanvasSimulationRichOutput", () => {
  let ctxMock: {
    clearRect: jest.Mock
    fillRect: jest.Mock
    beginPath: jest.Mock
    moveTo: jest.Mock
    lineTo: jest.Mock
    stroke: jest.Mock
    fillStyle: string
    strokeStyle: string
    lineWidth: number
  }
  let getContextSpy: jest.SpyInstance
  let rafSpy: jest.SpyInstance
  let latestRafCallback: FrameRequestCallback | null

  beforeEach(() => {
    ctxMock = {
      clearRect: jest.fn(),
      fillRect: jest.fn(),
      beginPath: jest.fn(),
      moveTo: jest.fn(),
      lineTo: jest.fn(),
      stroke: jest.fn(),
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 0,
    }
    getContextSpy = jest
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockImplementation(() => ctxMock as unknown as CanvasRenderingContext2D)

    // Capture the latest RAF callback without auto-firing it, so tests can
    // step the animation deterministically (and the renderFrame self-RAF
    // chain doesn't infinite-loop).
    latestRafCallback = null
    rafSpy = jest.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      latestRafCallback = cb
      return 1
    })
    jest.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {})
  })

  afterEach(() => {
    getContextSpy.mockRestore()
    rafSpy.mockRestore()
    jest.restoreAllMocks()
  })

  function step() {
    const cb = latestRafCallback
    latestRafCallback = null
    if (cb) cb(0)
  }

  it("uses the resolved --primary CSS variable for the stroke style", async () => {
    document.documentElement.style.setProperty("--primary", "#ff00aa")
    render(<CanvasSimulationRichOutput config={{ amplitude: 10, frequency: 1 }} />)

    // Hook's useEffect runs after mount, reads --primary, calls setState.
    // Wait for the re-render so the canvas effect captures the live value.
    await act(async () => {
      await Promise.resolve()
    })

    step()

    expect(ctxMock.strokeStyle).toBe("#ff00aa")
    expect(ctxMock.stroke).toHaveBeenCalled()
  })

  it("falls back to the default primary value when the var is unset", async () => {
    document.documentElement.removeAttribute("style")
    render(<CanvasSimulationRichOutput />)
    await act(async () => {
      await Promise.resolve()
    })
    step()
    expect(ctxMock.strokeStyle).toBe("#0ea5e9")
  })
})
