/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import { TtsVoiceSelector } from "./tts-voice-selector"

const speak = jest.fn().mockResolvedValue(undefined)
const stop = jest.fn()

jest.mock("@/hooks/media", () => ({
  useTTS: () => ({ speak, stop, isPlaying: false, isLoading: false }),
}))

describe("TtsVoiceSelector", () => {
  beforeEach(() => {
    speak.mockClear()
    stop.mockClear()
  })

  it("searches and selects a provider voice", () => {
    const onValueChange = jest.fn()
    render(
      <TtsVoiceSelector
        value="alloy"
        options={[
          { id: "alloy", name: "Alloy", description: "Balanced" },
          { id: "nova", name: "Nova", description: "Warm" },
        ]}
        onValueChange={onValueChange}
      />
    )

    fireEvent.click(screen.getByRole("combobox"))
    fireEvent.change(screen.getByPlaceholderText("Search voices…"), {
      target: { value: "warm" },
    })
    fireEvent.click(screen.getByText("Nova"))

    expect(onValueChange).toHaveBeenCalledWith("nova")
  })

  it("previews with the selected provider overlay", async () => {
    render(
      <TtsVoiceSelector
        value="alloy"
        options={[{ id: "alloy", name: "Alloy" }]}
        onValueChange={jest.fn()}
        getVoiceOverlay={(voiceId) => ({
          ttsProvider: "openai",
          openaiVoice: voiceId as "alloy",
        })}
      />
    )

    fireEvent.click(screen.getByRole("combobox"))
    fireEvent.click(screen.getByRole("button", { name: "Preview voice" }))

    await waitFor(() => expect(speak).toHaveBeenCalledTimes(1))
  })
})
