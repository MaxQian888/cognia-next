import {
  act,
  fireEvent,
  render as renderWithTestingLibrary,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { StrictMode, type ReactElement } from "react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useSandboxDesktopStream } from "@/hooks/automation/use-sandbox-desktop-stream"
import { resetComputerUsePipResources } from "@/lib/automation/computer-use-pip-resources"

function render(ui: ReactElement) {
  return renderWithTestingLibrary(ui, { wrapper: TooltipProvider })
}

const settingsGet = jest.fn()
let mockReducedMotion = false

// The session's bound sandbox desktop, if any (ADR-0234 Phase 1).
let mockSandboxDesktop: {
  connectionId: string
  enabled: boolean
  allowStreaming?: boolean
} | null = null
let mockTargetDesktop: { connectionId: string; enabled: boolean } | undefined
const revealSessionPanel = jest.fn()
jest.mock("@/hooks/automation/use-sandbox-desktop-stream", () => ({
  useSandboxDesktopStream: jest.fn(() => ({ grant: null, status: "idle", attachFrame: jest.fn() })),
}))
jest.mock("@/hooks/automation/use-session-sandbox-desktop", () => ({
  useSessionSandboxDesktop: (_sessionId: string, target?: string | null) =>
    target ? (mockTargetDesktop ?? mockSandboxDesktop) : mockSandboxDesktop,
}))
jest.mock("@/lib/artifacts/reveal", () => ({
  revealSessionPanel: (...args: unknown[]) => revealSessionPanel(...args),
}))

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
  COMPUTER_USE_PIP_RETENTION_MS,
  publishComputerUsePipFrame,
} from "@/lib/automation/computer-use-pip"
import { makeSessionSlice, useChatStore } from "@/stores/chat"
import { ComputerUsePictureInPicture, resizeGrowth } from "./computer-use-picture-in-picture"

const SID = "session-1"

it("shows independent target cards and restores a selected hidden target", async () => {
  for (const id of ["Editor", "Browser"]) {
    const activity = publishComputerUseActivity(SID, "get_app_state", undefined, undefined, null, {
      id,
      label: id,
    })
    publishComputerUsePipFrame(SID, { output: id, width: 800, height: 600 }, activity)
  }
  render(
    <div data-computer-use-pip-host>
      <ComputerUsePictureInPicture sessionId={SID} />
    </div>
  )
  const editor = await screen.findByRole("region", { name: "Editor" })
  const browser = screen.getByRole("region", { name: "Browser" })
  expect(within(editor).getByRole("img")).toHaveAttribute("src", "data:image/png;base64,Editor")
  expect(within(browser).getByRole("img")).toHaveAttribute("src", "data:image/png;base64,Browser")
  fireEvent.click(within(editor).getByRole("button", { name: /hide picture/i }))
  expect(screen.queryByRole("region", { name: "Editor" })).not.toBeInTheDocument()
  expect(screen.getByRole("region", { name: "Browser" })).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: /Show preview: Editor/ }))
  expect(await screen.findByRole("region", { name: "Editor" })).toBeInTheDocument()
  expect(settingsGet).toHaveBeenCalledTimes(1)
})

it("keeps the other view when one duplicate view changes chat", async () => {
  publishComputerUseActivity(SID, "screenshot", {
    ok: true,
    output: "FRAME",
    display_width_px: 800,
    display_height_px: 600,
  })
  const view = render(
    <>
      <div data-computer-use-pip-host>
        <ComputerUsePictureInPicture sessionId={SID} />
      </div>
      <div data-computer-use-pip-host>
        <ComputerUsePictureInPicture sessionId={SID} />
      </div>
    </>
  )
  await waitFor(() => expect(screen.getAllByRole("region")).toHaveLength(2))
  view.rerender(
    <>
      <div data-computer-use-pip-host>
        <ComputerUsePictureInPicture sessionId="other" />
      </div>
      <div data-computer-use-pip-host>
        <ComputerUsePictureInPicture sessionId={SID} />
      </div>
    </>
  )
  expect(screen.getByRole("img")).toHaveAttribute("src", "data:image/png;base64,FRAME")
})

it("starts with the four most recent targets while keeping every target selectable", async () => {
  for (let index = 0; index < 8; index++) {
    const activity = publishComputerUseActivity(SID, "get_app_state", undefined, undefined, null, {
      id: `app-${index}`,
      label: `Application ${index + 1}`,
    })
    publishComputerUsePipFrame(SID, { output: `FRAME-${index}`, width: 800, height: 600 }, activity)
  }
  render(
    <div data-computer-use-pip-host>
      <ComputerUsePictureInPicture sessionId={SID} />
    </div>
  )
  await screen.findByRole("region", { name: "Application 8" })
  expect(screen.getAllByRole("region").map((region) => region.getAttribute("aria-label"))).toEqual([
    "Application 5",
    "Application 6",
    "Application 7",
    "Application 8",
  ])
  expect(
    within(screen.getByRole("toolbar", { name: "Computer Use previews" })).getAllByRole("button")
  ).toHaveLength(8)
  fireEvent.click(screen.getByRole("button", { name: /Show preview: Application 1/ }))
  expect(await screen.findByRole("region", { name: "Application 1" })).toBeInTheDocument()
})

it("releases a hidden card's frame pin while keeping its restore control", async () => {
  publishComputerUseActivity(SID, "screenshot", {
    ok: true,
    output: "FRAME",
    display_width_px: 800,
    display_height_px: 600,
  })
  render(
    <div data-computer-use-pip-host>
      <ComputerUsePictureInPicture sessionId={SID} />
    </div>
  )
  await screen.findByRole("img")
  fireEvent.click(screen.getByRole("button", { name: /hide picture in picture/i }))
  act(() => {
    for (let index = 0; index < 9; index++) {
      publishComputerUseActivity(`background-${index}`, "screenshot", {
        ok: true,
        output: `FRAME-${index}`,
        display_width_px: 800,
        display_height_px: 600,
      })
    }
  })
  expect(getComputerUsePipSnapshot(SID).frame).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: /show picture in picture/i }))
  expect(await screen.findByText("Preview unavailable")).toBeInTheDocument()
})

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
  resetComputerUsePipResources()
  mockTargetDesktop = undefined
  ;(useSandboxDesktopStream as jest.Mock).mockReturnValue({
    grant: null,
    status: "idle",
    attachFrame: jest.fn(),
  })
  mockSandboxDesktop = null
  revealSessionPanel.mockReset()
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
  it("disables enlargement rather than opening an empty dialog for another live desktop without a frame", async () => {
    mockSandboxDesktop = { connectionId: "configured-a", enabled: true }
    mockTargetDesktop = { connectionId: "actual-b", enabled: true }
    seedStatus(SID, "streaming")
    publishComputerUseActivity(SID, "get_app_state", undefined, undefined, "actual-b")
    ;(useSandboxDesktopStream as jest.Mock).mockReturnValue({
      grant: { url: "http://127.0.0.1/live-b", role: "viewer" },
      status: "open",
      attachFrame: jest.fn(),
    })
    render(
      <div data-computer-use-pip-host>
        <ComputerUsePictureInPicture sessionId={SID} />
      </div>
    )
    await screen.findByTitle("Live Computer Use preview")
    const enlarge = screen.getByRole("button", { name: "View larger" })
    expect(enlarge).toBeDisabled()
    fireEvent.click(enlarge)
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(revealSessionPanel).not.toHaveBeenCalled()
  })
  it("keeps an opaque Lume binding as a screenshot without opening a different configured desktop", async () => {
    mockSandboxDesktop = { connectionId: "lume-row", enabled: true, allowStreaming: false }
    publishComputerUseActivity(
      SID,
      "screenshot",
      { ok: true, output: "FRAME", display_width_px: 800, display_height_px: 600 },
      undefined,
      "lume-binding:run-1"
    )
    render(
      <div data-computer-use-pip-host>
        <ComputerUsePictureInPicture sessionId={SID} />
      </div>
    )
    await screen.findByRole("region")
    expect(screen.queryByRole("button", { name: /open sandbox desktop/i })).toBeNull()
    expect(revealSessionPanel).not.toHaveBeenCalled()
    expect(screen.queryByTitle("Live Computer Use preview")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: /view larger/i }))
    expect(screen.getByRole("dialog")).toBeInTheDocument()
  })
  it("only shows a live observer for the actual action target and disables it when hidden or ended", async () => {
    const stream = useSandboxDesktopStream as jest.Mock
    stream.mockReturnValue({
      grant: { url: "http://127.0.0.1/view", role: "viewer" },
      status: "open",
      attachFrame: jest.fn(),
    })
    mockSandboxDesktop = { connectionId: "c1", enabled: true }
    seedStatus(SID, "streaming")
    publishComputerUseActivity(SID, "get_app_state", undefined, undefined, "c1")
    const { rerender } = render(
      <div data-computer-use-pip-host>
        <ComputerUsePictureInPicture sessionId={SID} />
      </div>
    )
    await screen.findByTitle("Live Computer Use preview")
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Live"))
    const visibility = jest.spyOn(document, "visibilityState", "get")
    act(() => {
      visibility.mockReturnValue("hidden")
      document.dispatchEvent(new Event("visibilitychange"))
    })
    await waitFor(() => expect(screen.queryByTitle("Live Computer Use preview")).toBeNull())
    stream.mockClear()
    act(() => {
      publishComputerUsePipFrame(SID, { output: "HIDDEN", width: 800, height: 600 })
    })
    expect(stream).not.toHaveBeenCalled()
    act(() => {
      visibility.mockReturnValue("visible")
      document.dispatchEvent(new Event("visibilitychange"))
    })
    await screen.findByTitle("Live Computer Use preview")
    expect(stream).toHaveBeenLastCalledWith("c1", true, expect.any(Object))
    fireEvent.click(screen.getByRole("button", { name: /hide picture in picture/i }))
    expect(screen.queryByTitle("Live Computer Use preview")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: /show picture in picture/i }))
    expect(stream).toHaveBeenLastCalledWith("c1", true, expect.any(Object))
    act(() => seedStatus(SID, "idle"))
    await waitFor(() => expect(stream).toHaveBeenLastCalledWith("c1", false, expect.any(Object)))
    mockSandboxDesktop = { connectionId: "other", enabled: true }
    rerender(
      <div data-computer-use-pip-host>
        <ComputerUsePictureInPicture sessionId={SID} />
      </div>
    )
    expect(screen.queryByTitle("Live Computer Use preview")).toBeNull()
    expect(screen.queryByRole("button", { name: /open sandbox desktop/i })).toBeNull()
  })

  it("shows a translated decode failure and recovers when the image loads", async () => {
    publishComputerUseActivity(SID, "screenshot", {
      ok: true,
      output: "FRAME",
      display_width_px: 800,
      display_height_px: 600,
    })
    render(
      <div data-computer-use-pip-host>
        <ComputerUsePictureInPicture sessionId={SID} />
      </div>
    )
    const image = await screen.findByRole("img", { name: /computer use screen/i })
    fireEvent.error(image)
    expect(screen.getByText("Preview unavailable")).toBeInTheDocument()
    expect(image).toHaveClass("opacity-0")
    fireEvent.load(image)
    expect(screen.queryByText("Preview unavailable")).toBeNull()
    expect(image).not.toHaveClass("opacity-0")
  })

  it("coalesces scroll bursts into one geometry batch", async () => {
    const callbacks: FrameRequestCallback[] = []
    const raf = jest.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callbacks.push(callback)
      return callbacks.length
    })
    publishComputerUseActivity(SID, "get_app_state")
    render(
      <div data-computer-use-pip-host>
        <div data-computer-use-pip-obstacle />
        <ComputerUsePictureInPicture sessionId={SID} />
      </div>
    )
    await screen.findByRole("region", { name: /computer use/i })
    act(() => {
      for (const callback of callbacks.splice(0)) callback(0)
    })
    raf.mockClear()
    const rectangles = HTMLElement.prototype.getBoundingClientRect as jest.Mock
    rectangles.mockClear()
    act(() => {
      for (let i = 0; i < 100; i++) document.dispatchEvent(new Event("scroll"))
    })
    expect(raf).toHaveBeenCalledTimes(1)
    expect(rectangles).not.toHaveBeenCalled()
    act(() => {
      callbacks.splice(0).forEach((callback) => callback(0))
    })
    expect(rectangles).toHaveBeenCalledTimes(2)
  })

  it("reuses one image node across continuous frame updates", async () => {
    publishComputerUseActivity(SID, "screenshot", {
      ok: true,
      output: "FIRST",
      display_width_px: 800,
      display_height_px: 600,
    })
    render(
      <div data-computer-use-pip-host>
        <ComputerUsePictureInPicture sessionId={SID} />
      </div>
    )
    const image = await screen.findByRole("img", { name: /computer use screen/i })
    for (let i = 0; i < 60; i++) {
      act(() => {
        publishComputerUseActivity(SID, "screenshot", {
          ok: true,
          output: `FRAME-${i}`,
          display_width_px: 800,
          display_height_px: 600,
        })
      })
      expect(screen.getByRole("img", { name: /computer use screen/i })).toBe(image)
    }
    expect(screen.getAllByRole("img", { name: /computer use screen/i })).toHaveLength(1)
  })

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

  it("opens the bound sandbox desktop in the chat dock only when the session has one", async () => {
    publishComputerUseActivity(
      SID,
      "screenshot",
      {
        ok: true,
        output: "FRAME",
        display_width_px: 1280,
        display_height_px: 800,
      },
      undefined,
      "c1"
    )
    const { rerender } = render(
      <div data-computer-use-pip-host>
        <ComputerUsePictureInPicture sessionId={SID} />
      </div>
    )
    await screen.findByRole("img", { name: /computer use screen/i })
    expect(screen.queryByRole("button", { name: /open sandbox desktop/i })).toBeNull()

    mockSandboxDesktop = { connectionId: "c1", enabled: true }
    rerender(
      <div data-computer-use-pip-host>
        <ComputerUsePictureInPicture sessionId={SID} />
      </div>
    )
    fireEvent.click(screen.getByRole("button", { name: /open sandbox desktop/i }))
    expect(revealSessionPanel).toHaveBeenCalledWith(SID, "sandbox-desktop")
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

  it("preserves the previous session snapshot when another view may still need it", () => {
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
    expect(getComputerUsePipSnapshot(SID).action).toBe("screenshot")
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

  it("retires completed activity after the last pane releases its retention", async () => {
    jest.useFakeTimers()
    publishComputerUseActivity(SID, "screenshot")
    const view = render(
      <div data-computer-use-pip-host>
        <ComputerUsePictureInPicture sessionId={SID} />
      </div>
    )
    await screen.findByRole("region", { name: /computer use/i })
    act(() => setComputerUsePipRunEnded(SID))
    view.unmount()
    expect(getComputerUsePipSnapshot(SID).action).toBe("screenshot")
    act(() => jest.advanceTimersByTime(COMPUTER_USE_PIP_RETENTION_MS * 2 + 1))
    expect(getComputerUsePipSnapshot(SID).action).toBeNull()
    jest.useRealTimers()
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
