/**
 * @jest-environment jsdom
 */

import { fireEvent, render } from "@testing-library/react"

import { TooltipProvider } from "@/components/ui/tooltip"
import { AudioBlock } from "./audio-block"

describe("AudioBlock", () => {
  it("swaps the animated play and pause states from media events", () => {
    const { container } = render(
      <TooltipProvider>
        <AudioBlock src="https://example.test/audio.mp3" title="Sample" />
      </TooltipProvider>
    )
    const audio = container.querySelector("audio")!

    expect(container.querySelector('[data-state="play"]')).toBeInTheDocument()
    fireEvent.play(audio)
    expect(container.querySelector('[data-state="pause"]')).toBeInTheDocument()
    fireEvent.pause(audio)
    expect(container.querySelector('[data-state="play"]')).toBeInTheDocument()
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
