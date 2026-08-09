/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

import { TestTtsButton } from "./test-tts-button"

const speakMock = jest.fn().mockResolvedValue(undefined)
const stopMock = jest.fn()
let lastUseTtsOptions: Record<string, unknown> = {}
let mockIsLoading = false
let mockIsPlaying = false

jest.mock("@/hooks/media", () => ({
  useTTS: (opts: Record<string, unknown>) => {
    lastUseTtsOptions = opts
    return { speak: speakMock, stop: stopMock, isPlaying: mockIsPlaying, isLoading: mockIsLoading }
  },
}))

jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T,>(selector: (s: { settings: { sttLanguage: string } }) => T): T =>
    selector({ settings: { sttLanguage: "en-US" } }),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@cognia/logging", () => ({
  loggers: { tts: { info: jest.fn() } },
}))

beforeEach(() => {
  speakMock.mockClear()
  stopMock.mockClear()
  lastUseTtsOptions = {}
  mockIsLoading = false
  mockIsPlaying = false
})

test("speaks the language-aware sample with no overlay (default behaviour)", () => {
  render(<TestTtsButton />)
  fireEvent.click(screen.getByRole("button"))
  expect(lastUseTtsOptions.voiceOverlay).toEqual({ ttsFallbackEnabled: false })
  expect(speakMock).toHaveBeenCalledWith("sample.en")
})

test("forwards voiceOverlay to useTTS and speaks the custom sample", () => {
  const overlay = { ttsProvider: "elevenlabs", elevenlabsVoice: "rachel" } as const
  render(<TestTtsButton voiceOverlay={overlay} sampleText="hello character" />)
  fireEvent.click(screen.getByRole("button"))
  expect(lastUseTtsOptions.voiceOverlay).toEqual({ ...overlay, ttsFallbackEnabled: false })
  expect(speakMock).toHaveBeenCalledWith("hello character")
})

test("cancels an in-flight provider test instead of disabling the button", () => {
  mockIsLoading = true
  render(<TestTtsButton />)
  const button = screen.getByRole("button")
  expect(button).toBeEnabled()
  fireEvent.click(button)
  expect(stopMock).toHaveBeenCalled()
  expect(speakMock).not.toHaveBeenCalled()
})
