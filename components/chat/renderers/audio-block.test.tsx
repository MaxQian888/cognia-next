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
