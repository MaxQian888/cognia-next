import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { StrictMode } from "react"

const settingsGet = jest.fn()
let mockReducedMotion = false

jest.mock("@/lib/automation/client", () => ({
  desktop: {
    settingsGet: (...args: unknown[]) => settingsGet(...args),
  },
}))

// Mock motion/react so exit animations resolve synchronously and `style` /
// `ref` pass straight through (the layout effect needs the real DOM node, and
// the geometry assertions read the forwarded inline styles).
jest.mock("motion/react", () => {
  const react = jest.requireActual<typeof import("react")>("react")
  const strip = (props: Record<string, unknown>) => {
    const {
      initial: _initial,
      animate: _animate,
      exit: _exit,
      transition: _transition,
      layout: _layout,
      layoutId: _layoutId,
      variants: _variants,
      whileHover: _whileHover,
      whileTap: _whileTap,
      ...rest
    } = props
    return rest
  }
  return {
    __esModule: true,
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useReducedMotion: () => mockReducedMotion,
    motion: {
      div: react.forwardRef<HTMLDivElement, Record<string, unknown>>(
        function MotionDiv(props, ref) {
          const { children, ...rest } = strip(props)
          return (
            <div ref={ref} {...rest}>
              {children as React.ReactNode}
            </div>
          )
        }
      ),
      img: react.forwardRef<HTMLImageElement, Record<string, unknown>>(
        function MotionImg(props, ref) {
          // eslint-disable-next-line jsx-a11y/alt-text -- alt is forwarded via props
          return <img ref={ref} {...strip(props)} />
        }
      ),
    },
  }
})

import {
  COMPUTER_USE_PIP_LAYOUT_STORAGE_KEY,
  clearComputerUsePipState,
  getComputerUsePipSnapshot,
  publishComputerUseActivity,
  setComputerUsePipRunEnded,
  suppressComputerUsePipForCapture,
} from "@/lib/automation/computer-use-pip"
import { makeSessionSlice, useChatStore } from "@/stores/chat"
import { ComputerUsePictureInPicture, resizeGrowth } from "./computer-use-picture-in-picture"

const SID = "session-1"

// jsdom has no coordinate-carrying PointerEvent, so back pointer events with a
// MouseEvent (which does carry clientX/clientY) and flush inside act().
function dispatchPointer(target: EventTarget, type: string, clientX: number, clientY: number) {
  act(() => {
    target.dispatchEvent(
      new MouseEvent(type, { clientX, clientY, bubbles: true, cancelable: true })
    )
  })
}

function seedStatus(
  sessionId: string,
  status: "idle" | "streaming" | "awaiting_approval" | "error"
) {
  useChatStore.setState({ sessions: { [sessionId]: { ...makeSessionSlice(), status } } })
}

beforeEach(() => {
  window.localStorage.removeItem(COMPUTER_USE_PIP_LAYOUT_STORAGE_KEY)
  mockReducedMotion = false
  settingsGet.mockReset().mockResolvedValue({ alwaysHidePictureInPicture: false })
  useChatStore.setState({ sessions: {} })
  jest.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    width: 1000,
    height: 800,
    top: 0,
    right: 1000,
    bottom: 800,
    left: 0,
    toJSON: () => ({}),
  })
})

afterEach(() => {
  clearComputerUsePipState()
  useChatStore.setState({ sessions: {} })
  jest.restoreAllMocks()
  jest.useRealTimers()
})

describe("resizeGrowth", () => {
  // The grip grows the surface away from whichever corner is pinned.
  it("grows away from the pinned corner for each alignment", () => {
    expect(resizeGrowth("bottomRight", -40, -10)).toBe(40)
    expect(resizeGrowth("bottomLeft", 40, -10)).toBe(40)
    expect(resizeGrowth("topLeft", 10, 40)).toBe(40)
    expect(resizeGrowth("topRight", -10, 40)).toBe(40)
  })
})

describe("ComputerUsePictureInPicture", () => {
  it("shows the latest computer-use frame and supports hide/restore", async () => {
    publishComputerUseActivity(SID, "screenshot", {
      ok: true,
      output: "FRAME",
      display_width_px: 1280,
      display_height_px: 800,
    })

    render(
      <div data-computer-use-pip-host>
        <ComputerUsePictureInPicture sessionId={SID} />
      </div>
    )

    const image = await screen.findByRole("img", { name: /computer use screen/i })
    expect(image).toHaveAttribute("src", "data:image/png;base64,FRAME")

    fireEvent.click(screen.getByRole("button", { name: /hide picture in picture/i }))
    expect(screen.queryByRole("img", { name: /computer use screen/i })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: /show picture in picture/i }))
    expect(screen.getByRole("img", { name: /computer use screen/i })).toBeInTheDocument()
  })

  it("stays absent until a session has Computer Use activity", () => {
    render(<ComputerUsePictureInPicture sessionId={SID} />)
    expect(screen.queryByRole("region")).not.toBeInTheDocument()
    expect(settingsGet).not.toHaveBeenCalled()
  })

  it("honors the global always-hide preference", async () => {
    settingsGet.mockResolvedValueOnce({ alwaysHidePictureInPicture: true })
    publishComputerUseActivity(SID, "screenshot")
    render(<ComputerUsePictureInPicture sessionId={SID} />)
    await waitFor(() => expect(settingsGet).toHaveBeenCalled())
    expect(screen.queryByRole("region")).not.toBeInTheDocument()
  })

  it("shows running and error activity without a screenshot", async () => {
    settingsGet.mockRejectedValueOnce(new Error("web stub"))
    publishComputerUseActivity(SID, "left_click")
    render(
      <div data-computer-use-pip-host>
        <ComputerUsePictureInPicture sessionId={SID} />
      </div>
    )

    expect(await screen.findByText(/waiting for the first screenshot/i)).toBeInTheDocument()
    expect(screen.getByText(/left-click/i)).toBeInTheDocument()

    act(() => {
      publishComputerUseActivity(SID, "left_click", { ok: false, error: "permission denied" })
    })
    expect(screen.getByText("permission denied")).toBeInTheDocument()

    act(() => {
      publishComputerUseActivity(SID, "left_click", { ok: false })
    })
    expect(screen.getByText(/computer use action failed/i)).toBeInTheDocument()
  })

  it("cycles between collision-resolved corners", async () => {
    publishComputerUseActivity(SID, "screenshot")
    render(
      <div data-computer-use-pip-host>
        <ComputerUsePictureInPicture sessionId={SID} />
      </div>
    )
    const region = await screen.findByRole("region", { name: /computer use/i })
    await waitFor(() => expect(region).toHaveStyle({ left: "726px", top: "490px" }))

    fireEvent.click(screen.getByRole("button", { name: /move picture in picture/i }))
    await waitFor(() => expect(region).toHaveStyle({ left: "24px", top: "490px" }))
  })

  it("moves clear of obstacles inside the chat viewport", async () => {
    ;(HTMLElement.prototype.getBoundingClientRect as jest.Mock).mockImplementation(function (
      this: HTMLElement
    ) {
      const rect = this.hasAttribute("data-computer-use-pip-obstacle")
        ? { x: 650, y: 600, width: 350, height: 200 }
        : { x: 0, y: 0, width: 1000, height: 800 }
      return {
        ...rect,
        top: rect.y,
        right: rect.x + rect.width,
        bottom: rect.y + rect.height,
        left: rect.x,
        toJSON: () => ({}),
      }
    })
    publishComputerUseActivity(SID, "screenshot")
    render(
      <div data-computer-use-pip-host>
        <div data-computer-use-pip-obstacle />
        <ComputerUsePictureInPicture sessionId={SID} />
      </div>
    )

    const region = await screen.findByRole("region", { name: /computer use/i })
    await waitFor(() => expect(region).toHaveStyle({ left: "726px", top: "302px" }))
  })

  it("sizes chrome outside the frame ratio and adapts when the display changes", async () => {
    publishComputerUseActivity(SID, "screenshot", {
      ok: true,
      output: "L",
      display_width_px: 1200,
      display_height_px: 600,
    })
    const { unmount } = render(
      <div data-computer-use-pip-host>
        <ComputerUsePictureInPicture sessionId={SID} />
      </div>
    )
    const landscape = await screen.findByRole("region", { name: /computer use/i })
    await waitFor(() =>
      expect(landscape).toHaveStyle({
        width: "250px",
        height: "161px",
        left: "726px",
        top: "615px",
      })
    )

    act(() => {
      publishComputerUseActivity(SID, "screenshot", {
        ok: true,
        output: "P",
        display_width_px: 600,
        display_height_px: 1200,
      })
    })
    await waitFor(() =>
      expect(landscape).toHaveStyle({
        width: "220px",
        height: "476px",
        left: "756px",
        top: "300px",
      })
    )
    expect(screen.getByRole("img", { name: /computer use screen/i })).toHaveAttribute(
      "src",
      "data:image/png;base64,P"
    )
    unmount()
  })

  it("reaches a done terminal on turn end and auto-collapses to the pill", async () => {
    jest.useFakeTimers()
    seedStatus(SID, "streaming")
    publishComputerUseActivity(SID, "left_click")
    render(
      <div data-computer-use-pip-host>
        <ComputerUsePictureInPicture sessionId={SID} />
      </div>
    )
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByText(/left-click/i)).toBeInTheDocument()

    act(() => seedStatus(SID, "idle"))
    expect(screen.getByText("Done")).toBeInTheDocument()
    expect(screen.queryByText(/left-click/i)).not.toBeInTheDocument()

    act(() => {
      jest.advanceTimersByTime(2500)
    })
    expect(screen.getByRole("button", { name: /show picture in picture/i })).toBeInTheDocument()
  })

  it("recognizes a completed background run when its chat pane mounts later", async () => {
    seedStatus(SID, "idle")
    publishComputerUseActivity(SID, "screenshot", {
      ok: true,
      output: "BACKGROUND",
      display_width_px: 100,
      display_height_px: 50,
    })
    render(
      <div data-computer-use-pip-host>
        <ComputerUsePictureInPicture sessionId={SID} />
      </div>
    )

    expect(await screen.findByText("Done")).toBeInTheDocument()
    expect(screen.getByRole("img", { name: /computer use screen/i })).toHaveAttribute(
      "src",
      "data:image/png;base64,BACKGROUND"
    )
  })

  it("keeps an error terminal expanded until the user handles it", async () => {
    jest.useFakeTimers()
    seedStatus(SID, "streaming")
    publishComputerUseActivity(SID, "left_click")
    render(
      <div data-computer-use-pip-host>
        <ComputerUsePictureInPicture sessionId={SID} />
      </div>
    )
    await act(async () => {
      await Promise.resolve()
    })

    act(() => seedStatus(SID, "error"))
    expect(screen.getByText(/computer use action failed/i)).toBeInTheDocument()

    act(() => {
      jest.advanceTimersByTime(10_000)
    })
    expect(screen.getByRole("region", { name: /computer use/i })).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: /show picture in picture/i })
    ).not.toBeInTheDocument()
  })

  it("pauses successful auto-collapse while hovered, then resumes after pointer leave", async () => {
    jest.useFakeTimers()
    seedStatus(SID, "streaming")
    publishComputerUseActivity(SID, "left_click")
    render(
      <div data-computer-use-pip-host>
        <ComputerUsePictureInPicture sessionId={SID} />
      </div>
    )
    await act(async () => Promise.resolve())
    const region = screen.getByRole("region", { name: /computer use/i })
    fireEvent.pointerEnter(region)
    act(() => seedStatus(SID, "idle"))
    act(() => jest.advanceTimersByTime(10_000))
    expect(region).toBeInTheDocument()

    fireEvent.pointerLeave(region)
    act(() => jest.advanceTimersByTime(2_500))
    expect(screen.getByRole("button", { name: /show picture in picture/i })).toBeInTheDocument()
  })

  it("re-expands on a new run after a manual hide", async () => {
    publishComputerUseActivity(SID, "left_click")
    render(
      <div data-computer-use-pip-host>
        <ComputerUsePictureInPicture sessionId={SID} />
      </div>
    )
    await screen.findByRole("region", { name: /computer use/i })
    fireEvent.click(screen.getByRole("button", { name: /hide picture in picture/i }))
    expect(screen.getByRole("button", { name: /show picture in picture/i })).toBeInTheDocument()

    // A fresh run (previous turn ended) re-expands the collapsed surface.
    act(() => {
      setComputerUsePipRunEnded(SID)
      publishComputerUseActivity(SID, "screenshot")
    })
    expect(screen.getByRole("region", { name: /computer use/i })).toBeInTheDocument()
  })

  it("shows relative frame freshness while running", async () => {
    jest.useFakeTimers()
    jest.setSystemTime(1_700_000_000_000)
    seedStatus(SID, "streaming")
    publishComputerUseActivity(SID, "screenshot", {
      ok: true,
      output: "F",
      display_width_px: 100,
      display_height_px: 50,
    })
    render(
      <div data-computer-use-pip-host>
        <ComputerUsePictureInPicture sessionId={SID} />
      </div>
    )
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByText(/just now/i)).toBeInTheDocument()

    // advanceTimersByTime moves the fake clock, so the ticker reads t0 + 8s.
    act(() => {
      jest.advanceTimersByTime(8000)
    })
    expect(screen.getByText(/8s ago/i)).toBeInTheDocument()
  })

  it("clears the previous session snapshot when the rendered chat switches", () => {
    publishComputerUseActivity(SID, "screenshot")
    const { rerender } = render(
      <div data-computer-use-pip-host>
        <ComputerUsePictureInPicture sessionId={SID} />
      </div>
    )
    rerender(
      <div data-computer-use-pip-host>
        <ComputerUsePictureInPicture sessionId="session-2" />
      </div>
    )
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- read the live singleton
    const { getComputerUsePipSnapshot } = require("@/lib/automation/computer-use-pip")
    expect(getComputerUsePipSnapshot(SID).action).toBeNull()
  })

  it("does not erase pre-mount activity during React Strict Mode effect replay", async () => {
    publishComputerUseActivity(SID, "screenshot", {
      ok: true,
      output: "FRAME",
      display_width_px: 100,
      display_height_px: 50,
    })
    render(
      <StrictMode>
        <div data-computer-use-pip-host>
          <ComputerUsePictureInPicture sessionId={SID} />
        </div>
      </StrictMode>
    )

    expect(await screen.findByRole("img", { name: /computer use screen/i })).toHaveAttribute(
      "src",
      "data:image/png;base64,FRAME"
    )
  })

  it("clears stale activity after a real pane unmount", async () => {
    publishComputerUseActivity(SID, "screenshot")
    const view = render(
      <div data-computer-use-pip-host>
        <ComputerUsePictureInPicture sessionId={SID} />
      </div>
    )
    await screen.findByRole("region", { name: /computer use/i })

    view.unmount()

    await waitFor(() => expect(getComputerUsePipSnapshot(SID).action).toBeNull())
  })

  it("removes the surface during capture and restores it after release", async () => {
    publishComputerUseActivity(SID, "screenshot", {
      ok: true,
      output: "FRAME",
      display_width_px: 100,
      display_height_px: 50,
    })
    render(
      <div data-computer-use-pip-host>
        <ComputerUsePictureInPicture sessionId={SID} />
      </div>
    )
    await screen.findByRole("region", { name: /computer use/i })

    let release = () => {}
    await act(async () => {
      release = await suppressComputerUsePipForCapture(SID)
    })
    expect(screen.queryByRole("region", { name: /computer use/i })).not.toBeInTheDocument()

    act(() => release())
    expect(await screen.findByRole("region", { name: /computer use/i })).toBeInTheDocument()
  })

  it("drags to reposition and snaps to the nearest corner on release", async () => {
    publishComputerUseActivity(SID, "screenshot")
    render(
      <div data-computer-use-pip-host>
        <ComputerUsePictureInPicture sessionId={SID} />
      </div>
    )
    const region = await screen.findByRole("region", { name: /computer use/i })
    await waitFor(() => expect(region).toHaveStyle({ left: "726px", top: "490px" }))

    // Grab the header (title area, not a control) and drag toward the top-left.
    dispatchPointer(screen.getByText("Computer Use"), "pointerdown", 800, 600)
    dispatchPointer(window, "pointermove", 300, 200)
    await waitFor(() => expect(region).toHaveStyle({ left: "226px", top: "90px" }))

    dispatchPointer(window, "pointerup", 300, 200)
    // Center lands in the top-left quadrant → snaps to the topLeft anchor.
    await waitFor(() => expect(region).toHaveStyle({ left: "24px", top: "24px" }))
  })

  it("cancels an interrupted drag instead of staying stuck to later pointer moves", async () => {
    publishComputerUseActivity(SID, "screenshot", {
      ok: true,
      output: "FRAME",
      display_width_px: 100,
      display_height_px: 100,
    })
    render(
      <div data-computer-use-pip-host>
        <ComputerUsePictureInPicture sessionId={SID} />
      </div>
    )
    const region = await screen.findByRole("region", { name: /computer use/i })
    await waitFor(() => expect(region).toHaveStyle({ left: "726px", top: "490px" }))

    dispatchPointer(screen.getByText("Computer Use"), "pointerdown", 800, 600)
    dispatchPointer(window, "pointermove", 700, 500)
    await waitFor(() => expect(region).toHaveStyle({ left: "626px", top: "390px" }))

    dispatchPointer(window, "pointercancel", 700, 500)
    dispatchPointer(window, "pointermove", 300, 200)
    await waitFor(() => expect(region).toHaveStyle({ left: "726px", top: "490px" }))
  })

  it("resizes from the corner grip", async () => {
    publishComputerUseActivity(SID, "screenshot")
    render(
      <div data-computer-use-pip-host>
        <ComputerUsePictureInPicture sessionId={SID} />
      </div>
    )
    const region = await screen.findByRole("region", { name: /computer use/i })
    await waitFor(() => expect(region).toHaveStyle({ width: "250px", height: "286px" }))

    const handle = region.querySelector("[data-pip-resize-handle]") as HTMLElement
    dispatchPointer(handle, "pointerdown", 100, 100)
    dispatchPointer(window, "pointermove", 50, 50)
    await waitFor(() => expect(region).toHaveStyle({ width: "300px", height: "336px" }))

    dispatchPointer(window, "pointerup", 50, 50)
    expect(region).toHaveStyle({ width: "300px", height: "336px" })

    // A second gesture starts from the already-resized box (userBox non-null).
    dispatchPointer(handle, "pointerdown", 100, 100)
    dispatchPointer(window, "pointermove", 60, 60)
    dispatchPointer(window, "pointerup", 60, 60)
    await waitFor(() => expect(region).toHaveStyle({ width: "340px", height: "376px" }))
  })

  it("lets keyboard users resize the surface", async () => {
    publishComputerUseActivity(SID, "screenshot", {
      ok: true,
      output: "FRAME",
      display_width_px: 100,
      display_height_px: 100,
    })
    render(
      <div data-computer-use-pip-host>
        <ComputerUsePictureInPicture sessionId={SID} />
      </div>
    )
    const region = await screen.findByRole("region", { name: /computer use/i })
    const resize = await screen.findByRole("button", { name: /resize picture in picture/i })

    act(() => resize.focus())
    fireEvent.keyDown(resize, { key: "ArrowUp" })
    await waitFor(() => expect(region).toHaveStyle({ width: "270px", height: "306px" }))
    expect(resize).toHaveFocus()
  })

  it("restores the device-level corner and size after remount", async () => {
    publishComputerUseActivity(SID, "screenshot", {
      ok: true,
      output: "FRAME",
      display_width_px: 100,
      display_height_px: 100,
    })
    const first = render(
      <div data-computer-use-pip-host>
        <ComputerUsePictureInPicture sessionId={SID} />
      </div>
    )
    const region = await screen.findByRole("region", { name: /computer use/i })
    fireEvent.click(screen.getByRole("button", { name: /move picture in picture/i }))
    const handle = region.querySelector("[data-pip-resize-handle]") as HTMLElement
    dispatchPointer(handle, "pointerdown", 100, 100)
    dispatchPointer(window, "pointermove", 150, 50)
    dispatchPointer(window, "pointerup", 150, 50)
    await waitFor(() => expect(region).toHaveStyle({ width: "300px", height: "336px" }))
    first.unmount()

    publishComputerUseActivity(SID, "screenshot", {
      ok: true,
      output: "NEXT",
      display_width_px: 100,
      display_height_px: 100,
    })
    render(
      <div data-computer-use-pip-host>
        <ComputerUsePictureInPicture sessionId={SID} />
      </div>
    )
    const restored = await screen.findByRole("region", { name: /computer use/i })
    await waitFor(() =>
      expect(restored).toHaveStyle({ width: "300px", height: "336px", left: "24px", top: "440px" })
    )
  })

  it("ignores drags that start on a header control", async () => {
    publishComputerUseActivity(SID, "screenshot")
    render(
      <div data-computer-use-pip-host>
        <ComputerUsePictureInPicture sessionId={SID} />
      </div>
    )
    const region = await screen.findByRole("region", { name: /computer use/i })
    await waitFor(() => expect(region).toHaveStyle({ left: "726px", top: "490px" }))

    // Pressing a header button must not begin a drag — position stays put.
    dispatchPointer(
      screen.getByRole("button", { name: /hide picture in picture/i }),
      "pointerdown",
      800,
      600
    )
    dispatchPointer(window, "pointermove", 300, 200)
    dispatchPointer(window, "pointerup", 300, 200)
    expect(region).toHaveStyle({ left: "726px", top: "490px" })
  })

  it("renders without motion when reduced motion is preferred", async () => {
    mockReducedMotion = true
    publishComputerUseActivity(SID, "screenshot", {
      ok: true,
      output: "FRAME",
      display_width_px: 100,
      display_height_px: 50,
    })
    render(
      <div data-computer-use-pip-host>
        <ComputerUsePictureInPicture sessionId={SID} />
      </div>
    )
    const region = await screen.findByRole("region", { name: /computer use/i })
    expect(region).not.toHaveClass("transition-[left,top,width,height]")
    // Collapse to the pill also renders under reduced motion.
    fireEvent.click(screen.getByRole("button", { name: /hide picture in picture/i }))
    expect(screen.getByRole("button", { name: /show picture in picture/i })).toBeInTheDocument()
  })

  it("opens a larger view when the frame is clicked", async () => {
    publishComputerUseActivity(SID, "screenshot", {
      ok: true,
      output: "FRAME",
      display_width_px: 100,
      display_height_px: 50,
    })
    render(
      <div data-computer-use-pip-host>
        <ComputerUsePictureInPicture sessionId={SID} />
      </div>
    )
    await screen.findByRole("region", { name: /computer use/i })
    fireEvent.click(screen.getByRole("button", { name: /view larger/i }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByRole("img", { name: /computer use screen/i })).toBeInTheDocument()
  })

  it("pauses successful auto-collapse while the larger view is open", async () => {
    jest.useFakeTimers()
    seedStatus(SID, "streaming")
    publishComputerUseActivity(SID, "screenshot", {
      ok: true,
      output: "FRAME",
      display_width_px: 100,
      display_height_px: 50,
    })
    render(
      <div data-computer-use-pip-host>
        <ComputerUsePictureInPicture sessionId={SID} />
      </div>
    )
    await act(async () => {
      await Promise.resolve()
    })
    fireEvent.click(screen.getByRole("button", { name: /view larger/i }))
    expect(await screen.findByRole("dialog")).toBeInTheDocument()

    act(() => seedStatus(SID, "idle"))
    act(() => {
      jest.advanceTimersByTime(10_000)
    })
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    expect(screen.getByRole("region", { name: /computer use/i })).toBeInTheDocument()
  })

  it("announces activity through a polite live region", async () => {
    publishComputerUseActivity(SID, "left_click")
    render(
      <div data-computer-use-pip-host>
        <ComputerUsePictureInPicture sessionId={SID} />
      </div>
    )
    const status = await screen.findByRole("status")
    expect(status).toHaveTextContent(/left-click/i)
    expect(status).toHaveAttribute("aria-live", "polite")
  })

  it("collapses the pill to the current corner", async () => {
    publishComputerUseActivity(SID, "screenshot")
    render(
      <div data-computer-use-pip-host>
        <ComputerUsePictureInPicture sessionId={SID} />
      </div>
    )
    await screen.findByRole("region", { name: /computer use/i })
    fireEvent.click(screen.getByRole("button", { name: /move picture in picture/i })) // → bottomLeft
    fireEvent.click(screen.getByRole("button", { name: /hide picture in picture/i }))

    const pill = screen.getByRole("button", { name: /show picture in picture/i })
    expect(pill.closest(".absolute")).toHaveStyle({ left: "24px", top: "740px" })
  })

  it("keeps the collapsed pill clear of chat obstacles", async () => {
    ;(HTMLElement.prototype.getBoundingClientRect as jest.Mock).mockImplementation(function (
      this: HTMLElement
    ) {
      const rect = this.hasAttribute("data-computer-use-pip-obstacle")
        ? { x: 0, y: 600, width: 350, height: 200 }
        : { x: 0, y: 0, width: 1000, height: 800 }
      return {
        ...rect,
        top: rect.y,
        right: rect.x + rect.width,
        bottom: rect.y + rect.height,
        left: rect.x,
        toJSON: () => ({}),
      }
    })
    publishComputerUseActivity(SID, "screenshot")
    render(
      <div data-computer-use-pip-host>
        <div data-computer-use-pip-obstacle />
        <ComputerUsePictureInPicture sessionId={SID} />
      </div>
    )
    await screen.findByRole("region", { name: /computer use/i })
    fireEvent.click(screen.getByRole("button", { name: /move picture in picture/i }))
    fireEvent.click(screen.getByRole("button", { name: /hide picture in picture/i }))

    const pill = screen.getByRole("button", { name: /show picture in picture/i })
    await waitFor(() =>
      expect(pill.closest(".absolute")).toHaveStyle({ left: "24px", top: "552px" })
    )
  })

  it("dismisses entirely for the current run via close", async () => {
    publishComputerUseActivity(SID, "left_click")
    render(
      <div data-computer-use-pip-host>
        <ComputerUsePictureInPicture sessionId={SID} />
      </div>
    )
    await screen.findByRole("region", { name: /computer use/i })
    fireEvent.click(screen.getByRole("button", { name: /^close$/i }))
    expect(screen.queryByRole("region", { name: /computer use/i })).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: /show picture in picture/i })
    ).not.toBeInTheDocument()
  })

  it("still renders when observer APIs are unavailable", async () => {
    const resizeObserver = global.ResizeObserver
    const mutationObserver = global.MutationObserver
    Object.defineProperty(global, "ResizeObserver", { configurable: true, value: undefined })
    Object.defineProperty(global, "MutationObserver", { configurable: true, value: undefined })
    publishComputerUseActivity(SID, "screenshot")

    render(
      <div data-computer-use-pip-host>
        <ComputerUsePictureInPicture sessionId={SID} />
      </div>
    )
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByRole("region", { name: /computer use/i })).toBeInTheDocument()

    Object.defineProperty(global, "ResizeObserver", { configurable: true, value: resizeObserver })
    Object.defineProperty(global, "MutationObserver", {
      configurable: true,
      value: mutationObserver,
    })
  })
})
