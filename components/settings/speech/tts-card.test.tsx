/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

let testSettings = { ttsEnabled: true, ttsProvider: "removed-provider" }
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      settings: testSettings,
      save: jest.fn(),
      setTtsEnabled: jest.fn(),
      setTtsProvider: jest.fn(),
      setTtsAutoPlay: jest.fn(),
      setTtsRate: jest.fn(),
      setTtsPitch: jest.fn(),
      setTtsVolume: jest.fn(),
    }),
}))

jest.mock("@/lib/platform/detect", () => ({
  detectPlatform: () => "web",
  isTauri: () => false,
  isCapacitor: () => false,
}))

jest.mock("./provider-config", () => ({
  PROVIDER_CONFIG_COMPONENTS: {
    system: () => <div>system-config</div>,
    openai: () => <div>openai-config</div>,
  },
}))

jest.mock("./test-tts-button", () => ({
  TestTtsButton: () => <button type="button">test-voice</button>,
}))

import { TtsCard } from "./tts-card"

it("normalizes an unknown persisted provider to system before rendering", () => {
  testSettings = { ttsEnabled: true, ttsProvider: "removed-provider" }
  render(<TtsCard />)
  expect(screen.getByText("system-config")).toBeInTheDocument()
})

it("warns that pure-web cloud calls expose browser CORS and key risks", () => {
  testSettings = { ttsEnabled: true, ttsProvider: "openai" }
  render(<TtsCard />)
  expect(screen.getByRole("status")).toHaveTextContent("webCloudWarning")
})
