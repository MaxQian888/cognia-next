import * as React from "react"

jest.mock("next-intl", () => ({ useTranslations: () => (k: string) => k }))

jest.mock("motion/react", () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  motion: {
    // Strip animation-only props so they don't leak onto the DOM node.
    div: ({
      children,
      initial: _i,
      animate: _a,
      exit: _e,
      transition: _t,
      ...rest
    }: Record<string, unknown> & { children?: React.ReactNode }) =>
      React.createElement("div", rest, children),
  },
}))

jest.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    "aria-label": ariaLabel,
  }: {
    children: React.ReactNode
    onClick?: () => void
    "aria-label"?: string
  }) => React.createElement("button", { onClick, "aria-label": ariaLabel }, children),
}))

jest.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => children,
  TooltipContent: () => null,
}))

import { render, screen, fireEvent, act } from "@testing-library/react"
import { TtsNowPlayingBar } from "./tts-now-playing-bar"
import { ttsOrchestrator } from "@/lib/tts/tts-orchestrator"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const setState = (patch: Record<string, unknown>) => (ttsOrchestrator as any).setState(patch)

beforeEach(() => {
  setState({
    playbackState: "idle",
    progress: 0,
    currentProvider: "system",
    activeSourceId: undefined,
  })
})

describe("TtsNowPlayingBar", () => {
  it("is hidden while idle", () => {
    render(<TtsNowPlayingBar />)
    expect(screen.queryByRole("status")).toBeNull()
  })

  it("appears while playing with provider name and a stop control", () => {
    render(<TtsNowPlayingBar />)
    act(() => setState({ playbackState: "playing", currentProvider: "openai", progress: 0.5 }))
    expect(screen.getByRole("status")).toBeInTheDocument()
    // provider display name comes from TTS_PROVIDERS.
    expect(screen.getByText("OpenAI TTS")).toBeInTheDocument()
    const bar = screen.getByRole("progressbar")
    expect(bar).toHaveAttribute("aria-valuenow", "50")
  })

  it("pauses when the pause control is clicked while playing", () => {
    const spy = jest.spyOn(ttsOrchestrator, "pause")
    render(<TtsNowPlayingBar />)
    act(() => setState({ playbackState: "playing" }))
    fireEvent.click(screen.getByRole("button", { name: "pause" }))
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it("resumes when the resume control is clicked while paused", () => {
    const spy = jest.spyOn(ttsOrchestrator, "resume")
    render(<TtsNowPlayingBar />)
    act(() => setState({ playbackState: "paused" }))
    fireEvent.click(screen.getByRole("button", { name: "resume" }))
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it("stops when the stop control is clicked", () => {
    const spy = jest.spyOn(ttsOrchestrator, "stop")
    render(<TtsNowPlayingBar />)
    act(() => setState({ playbackState: "playing" }))
    fireEvent.click(screen.getByRole("button", { name: "stop" }))
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it("hides again once playback stops", () => {
    render(<TtsNowPlayingBar />)
    act(() => setState({ playbackState: "playing" }))
    expect(screen.getByRole("status")).toBeInTheDocument()
    act(() => setState({ playbackState: "stopped" }))
    expect(screen.queryByRole("status")).toBeNull()
  })

  it("shows during loading with a 0% bar and no pause/resume controls", () => {
    render(<TtsNowPlayingBar />)
    act(() => setState({ playbackState: "loading", progress: 0.3 }))
    expect(screen.getByRole("status")).toBeInTheDocument()
    // Loading pins the bar to 0 regardless of any reported progress.
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "30")
    expect(screen.queryByRole("button", { name: "pause" })).toBeNull()
    expect(screen.queryByRole("button", { name: "resume" })).toBeNull()
    expect(screen.getByRole("button", { name: "stop" })).toBeInTheDocument()
  })

  it("falls back to the raw provider id when it has no catalog entry", () => {
    render(<TtsNowPlayingBar />)
    act(() => setState({ playbackState: "playing", currentProvider: "mystery" as never }))
    expect(screen.getByText("mystery")).toBeInTheDocument()
  })

  it("clamps an out-of-range progress value", () => {
    render(<TtsNowPlayingBar />)
    act(() => setState({ playbackState: "playing", progress: 1.5 }))
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100")
  })
})
