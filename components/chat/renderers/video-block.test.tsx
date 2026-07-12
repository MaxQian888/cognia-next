/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import { TooltipProvider } from "@/components/ui/tooltip"

import { VideoBlock } from "./video-block"

jest.mock("@/lib/files/download", () => ({
  downloadFromUrl: jest.fn(async () => undefined),
}))
jest.mock("@/lib/tauri/opener", () => ({
  openExternal: jest.fn(async () => undefined),
}))
jest.mock("@/lib/logging", () => ({
  loggers: { chat: { warn: jest.fn() } },
}))

import { openExternal } from "@/lib/tauri/opener"
import { downloadFromUrl } from "@/lib/files/download"
import { loggers } from "@/lib/logging"

const mockOpenExternal = openExternal as jest.Mock
const mockDownload = downloadFromUrl as jest.Mock
const mockWarn = loggers.chat.warn as jest.Mock

// jsdom does not implement media playback / fullscreen — stub them.
const play = jest.fn().mockResolvedValue(undefined)
const pause = jest.fn()
const requestFullscreen = jest.fn().mockResolvedValue(undefined)
beforeAll(() => {
  Object.defineProperty(window.HTMLMediaElement.prototype, "play", { value: play, writable: true })
  Object.defineProperty(window.HTMLMediaElement.prototype, "pause", {
    value: pause,
    writable: true,
  })
  Object.defineProperty(window.HTMLElement.prototype, "requestFullscreen", {
    value: requestFullscreen,
    writable: true,
  })
})

const messages = { chat: { renderers: { video: {} } } }

function renderBlock(props: Partial<React.ComponentProps<typeof VideoBlock>> = {}) {
  const result = render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <TooltipProvider>
        <VideoBlock src="https://example.com/clip.mp4" {...props} />
      </TooltipProvider>
    </NextIntlClientProvider>
  )
  const video = result.container.querySelector("video")
  if (video) fireEvent.loadedMetadata(video) // reveal controls (isLoading → false)
  return { ...result, video }
}

beforeEach(() => {
  mockOpenExternal.mockClear()
  mockDownload.mockClear().mockResolvedValue(undefined)
  mockWarn.mockClear()
  play.mockClear()
  pause.mockClear()
  requestFullscreen.mockClear()
})

describe("VideoBlock", () => {
  it("renders a native <video> for a direct file source", () => {
    const { video } = renderBlock()
    expect(video).toHaveAttribute("src", "https://example.com/clip.mp4")
    expect(video).toHaveAttribute("playsinline")
  })

  it("keeps the control overlay reachable on touch (pointer-coarse)", () => {
    const { container } = renderBlock()
    expect(container.querySelector(".pointer-coarse\\:opacity-100")).toBeTruthy()
  })

  it("plays then pauses via the play/pause control", () => {
    renderBlock()
    fireEvent.click(screen.getByRole("button", { name: "Play" }))
    expect(play).toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Pause" }))
    expect(pause).toHaveBeenCalled()
  })

  it("toggles mute", () => {
    const { video } = renderBlock()
    fireEvent.click(screen.getByRole("button", { name: "Mute" }))
    expect(video).toHaveProperty("muted", true)
    fireEvent.click(screen.getByRole("button", { name: "Unmute" }))
  })

  it("requests fullscreen", () => {
    renderBlock()
    fireEvent.click(screen.getByRole("button", { name: "Fullscreen" }))
    expect(requestFullscreen).toHaveBeenCalled()
  })

  it("exits fullscreen when already in fullscreen", () => {
    renderBlock()
    const exit = jest.fn().mockResolvedValue(undefined)
    Object.defineProperty(document, "fullscreenElement", { value: {}, configurable: true })
    Object.defineProperty(document, "exitFullscreen", { value: exit, configurable: true })
    fireEvent.click(screen.getByRole("button", { name: "Fullscreen" }))
    expect(exit).toHaveBeenCalled()
    Object.defineProperty(document, "fullscreenElement", { value: null, configurable: true })
  })

  it("seeks via the range slider", () => {
    const { video } = renderBlock()
    fireEvent.change(screen.getByRole("slider"), { target: { value: "12" } })
    expect(video?.currentTime).toBe(12)
  })

  it("downloads through the mobile-aware helper and logs on failure", async () => {
    mockDownload.mockRejectedValueOnce(new Error("net down"))
    renderBlock()
    fireEvent.click(screen.getByRole("button", { name: "Download" }))
    expect(mockDownload).toHaveBeenCalledWith("https://example.com/clip.mp4", "video")
    await Promise.resolve()
    await Promise.resolve()
    expect(mockWarn).toHaveBeenCalled()
  })

  it("routes the error-state 'open' action through openExternal, not window.open", () => {
    const { video } = renderBlock()
    fireEvent.error(video!)
    fireEvent.click(screen.getByRole("button", { name: "Open URL" }))
    expect(mockOpenExternal).toHaveBeenCalledWith("https://example.com/clip.mp4")
  })

  it("embeds a YouTube URL as an iframe (no raw <video>)", () => {
    const { container } = renderBlock({ src: "https://youtu.be/dQw4w9WgXcQ" })
    const iframe = container.querySelector("iframe")
    expect(iframe?.getAttribute("src") ?? "").toContain("youtube.com/embed/dQw4w9WgXcQ")
    expect(container.querySelector("video")).toBeNull()
  })

  it("embeds a Vimeo URL as an iframe", () => {
    const { container } = renderBlock({ src: "https://vimeo.com/123456789" })
    expect(container.querySelector("iframe")?.getAttribute("src") ?? "").toContain(
      "player.vimeo.com/video/123456789"
    )
  })

  it("embeds a Bilibili URL as an iframe", () => {
    const { container } = renderBlock({ src: "https://www.bilibili.com/video/BV1xx411c7mD" })
    expect(container.querySelector("iframe")).toBeTruthy()
  })

  it("renders a caption when a title is provided", () => {
    renderBlock({ title: "My clip" })
    expect(screen.getByText("My clip")).toBeInTheDocument()
  })

  it("reflects playback position on timeupdate", () => {
    const { video } = renderBlock()
    Object.defineProperty(video, "currentTime", { value: 65, configurable: true })
    fireEvent.timeUpdate(video!)
    // formatVideoTime(65) → "1:05"
    expect(screen.getByText(/1:05/)).toBeInTheDocument()
  })

  it("passes autoplay through to the embed iframe", () => {
    const { container } = renderBlock({ src: "https://youtu.be/abc123", autoPlay: true })
    expect(container.querySelector("iframe")?.getAttribute("src") ?? "").toContain("autoplay=1")
  })

  it("downloads successfully without logging a warning", async () => {
    renderBlock()
    fireEvent.click(screen.getByRole("button", { name: "Download" }))
    await Promise.resolve()
    expect(mockDownload).toHaveBeenCalled()
    expect(mockWarn).not.toHaveBeenCalled()
  })

  it("honors the muted and loop props", () => {
    const { video } = renderBlock({ muted: true, loop: true })
    expect(video).toHaveProperty("loop", true)
    // muted prop → initial state shows the Unmute affordance.
    expect(screen.getByRole("button", { name: "Unmute" })).toBeInTheDocument()
  })

  it("embeds a Bilibili av-number URL", () => {
    const { container } = renderBlock({ src: "https://www.bilibili.com/video/av12345" })
    expect(container.querySelector("iframe")).toBeTruthy()
    expect(container.querySelector("video")).toBeNull()
  })

  it("tracks native play/pause/ended events from the element", () => {
    const { video } = renderBlock()
    fireEvent.play(video!)
    // Element-driven play flips the control to Pause.
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument()
    fireEvent.pause(video!)
    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument()
    fireEvent.ended(video!)
    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument()
  })
})
