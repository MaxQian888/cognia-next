/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen } from "@testing-library/react"

jest.mock("./speech/stt-card", () => ({
  SttCard: () => <div>stt-card</div>,
}))
jest.mock("./speech/live-voice-card", () => ({
  LiveVoiceCard: () => <div>live-voice-card</div>,
}))
jest.mock("./speech/tts-card", () => ({
  TtsCard: () => <div>tts-card</div>,
}))

import { SpeechSection } from "./speech-section"

it("renders dictation, live voice, and text-to-speech settings", () => {
  render(<SpeechSection />)
  expect(screen.getByText("stt-card")).toBeInTheDocument()
  expect(screen.getByText("live-voice-card")).toBeInTheDocument()
  expect(screen.getByText("tts-card")).toBeInTheDocument()
})
