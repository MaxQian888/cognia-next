/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

import { TestTtsButton } from "./test-tts-button"

const speakMock = jest.fn().mockResolvedValue(undefined)
const stopMock = jest.fn()
let lastUseTtsOptions: Record<string, unknown> = {}

jest.mock("@/hooks/media", () => ({
  useTTS: (opts: Record<string, unknown>) => {
    lastUseTtsOptions = opts
    return { speak: speakMock, stop: stopMock, isPlaying: false, isLoading: false }
  },
}))

jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T,>(selector: (s: { settings: { sttLanguage: string } }) => T): T =>
    selector({ settings: { sttLanguage: "en-US" } }),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/lib/logging", () => ({
  loggers: { tts: { info: jest.fn() } },
}))

beforeEach(() => {
  speakMock.mockClear()
  stopMock.mockClear()
  lastUseTtsOptions = {}
})

test("speaks the language-aware sample with no overlay (default behaviour)", () => {
  render(<TestTtsButton />)
  fireEvent.click(screen.getByRole("button"))
  expect(lastUseTtsOptions.voiceOverlay).toBeUndefined()
  expect(speakMock).toHaveBeenCalledWith("sample.en")
})

test("forwards voiceOverlay to useTTS and speaks the custom sample", () => {
  const overlay = { ttsProvider: "elevenlabs", elevenlabsVoice: "rachel" } as const
  render(<TestTtsButton voiceOverlay={overlay} sampleText="hello character" />)
  fireEvent.click(screen.getByRole("button"))
  expect(lastUseTtsOptions.voiceOverlay).toEqual(overlay)
  expect(speakMock).toHaveBeenCalledWith("hello character")
})
