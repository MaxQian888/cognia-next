/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"

import { TooltipProvider } from "@/components/ui/tooltip"
import { AudioBlock } from "./audio-block"

describe("AudioBlock", () => {
  it("renders the complete media control surface", () => {
    const { container } = render(
      <TooltipProvider>
        <AudioBlock src="https://example.test/audio.mp3" title="Sample" />
      </TooltipProvider>
    )
    expect(container.querySelector('[data-slot="audio-player"]')).toBeInTheDocument()
    expect(container.querySelector('[data-slot="audio-player-element"]')).toHaveAttribute(
      "src",
      "https://example.test/audio.mp3"
    )
    expect(container.querySelector('[data-slot="audio-player-play-button"]')).toBeInTheDocument()
    expect(
      container.querySelector('[data-slot="audio-player-seek-backward-button"]')
    ).toBeInTheDocument()
    expect(
      container.querySelector('[data-slot="audio-player-seek-forward-button"]')
    ).toBeInTheDocument()
    expect(container.querySelector('[data-slot="audio-player-time-range"]')).toBeInTheDocument()
  })

  it("keeps every control on the card at phone widths instead of clipping them", () => {
    // The vendored ButtonGroup this bar renders into is `w-fit`: it sizes to
    // its children and cannot shrink, so at 375px the duration readout and the
    // mute button ran past the card and off-screen. The fix reclaims width
    // (tighter control padding, smaller cover, less card chrome) and gives the
    // seek bar its own row rather than dropping any control.
    const { container } = render(
      <TooltipProvider>
        <AudioBlock src="https://example.test/audio.mp3" title="Sample" />
      </TooltipProvider>
    )
    const bar = container.querySelector('[data-slot="audio-player-control-bar"]')
    const barClass = bar?.getAttribute("class") ?? ""
    // Narrow-screen width reclamation, and a wrap rather than a clip.
    expect(barClass).toContain("max-sm:[&_[data-slot=button-group]>*]:px-2")
    expect(barClass).toContain("max-sm:[&_[data-slot=button-group]]:flex-wrap")

    // The seek bar wraps to its own full-width line; `order-last` is what keeps
    // the readouts and mute on the first line instead of a third one.
    const range = container.querySelector('[data-slot="audio-player-time-range"]')
    const rangeClass = range?.getAttribute("class") ?? ""
    expect(rangeClass).toContain("max-sm:order-last")
    expect(rangeClass).toContain("max-sm:basis-full")

    // Nothing is hidden to make room: mute and both readouts still render.
    expect(container.querySelector('[data-slot="audio-player-mute-button"]')).toBeInTheDocument()
    expect(container.querySelector('[data-slot="audio-player-time-display"]')).toBeInTheDocument()
    expect(
      container.querySelector('[data-slot="audio-player-duration-display"]')
    ).toBeInTheDocument()
  })

  it("falls back to the native audio player after a media error", () => {
    const { container } = render(
      <TooltipProvider>
        <AudioBlock src="https://example.test/audio.mp3" title="Sample" />
      </TooltipProvider>
    )

    fireEvent.error(container.querySelector("audio")!)
    expect(screen.getByText(/failed to load audio/i)).toBeInTheDocument()
    expect(container.querySelector("audio[controls]")).toBeInTheDocument()
  })

  it("renders the download action with the animated download primitive", () => {
    const { container } = render(
      <TooltipProvider>
        <AudioBlock src="https://example.test/audio.mp3" title="Sample" />
      </TooltipProvider>
    )

    expect(container.querySelector('[data-slot="animated-action-icon"]')).toBeInTheDocument()
  })
})
