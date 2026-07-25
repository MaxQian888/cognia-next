/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

const saveMock = jest.fn()
let mockIsTauri = false

jest.mock("@/lib/tauri", () => ({ isTauri: () => mockIsTauri }))

jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T,>(
    selector: (s: { settings: Record<string, unknown>; save: typeof saveMock }) => T
  ): T =>
    selector({
      settings: { realtimeVoice: "marin", realtimeModel: "gpt-realtime" },
      save: saveMock,
    }),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("./api-key-input", () => ({
  ApiKeyInput: () => <div data-testid="api-key" />,
}))

import { MistralConfig, OpenAiRealtimeConfig, PROVIDER_CONFIG_COMPONENTS } from "./provider-config"

beforeEach(() => {
  saveMock.mockClear()
  mockIsTauri = false
})

describe("OpenAiRealtimeConfig", () => {
  it("registers in the provider component map", () => {
    expect(PROVIDER_CONFIG_COMPONENTS["openai-realtime"]).toBe(OpenAiRealtimeConfig)
  })

  it("shows the desktop-only notice in browser mode", () => {
    render(<OpenAiRealtimeConfig />)
    expect(screen.getByText("realtimeDesktopOnly")).toBeInTheDocument()
    expect(screen.getByText("realtimeIntro")).toBeInTheDocument()
  })

  it("hides the desktop-only notice when running in Tauri", () => {
    mockIsTauri = true
    render(<OpenAiRealtimeConfig />)
    expect(screen.queryByText("realtimeDesktopOnly")).not.toBeInTheDocument()
  })

  it("saves the delivery instructions on change", () => {
    render(<OpenAiRealtimeConfig />)
    const textarea = screen.getByPlaceholderText("voiceInstructionsPlaceholder")
    fireEvent.change(textarea, { target: { value: "sound excited" } })
    expect(saveMock).toHaveBeenCalledWith({ realtimeInstructions: "sound excited" })
  })
})

describe("MistralConfig", () => {
  it("registers in the provider component map", () => {
    expect(PROVIDER_CONFIG_COMPONENTS.mistral).toBe(MistralConfig)
  })

  it("persists the reusable voice id", () => {
    render(<MistralConfig />)
    fireEvent.change(screen.getByPlaceholderText("mistralVoiceIdPlaceholder"), {
      target: { value: "voice-123" },
    })
    expect(saveMock).toHaveBeenCalledWith({ mistralVoiceId: "voice-123" })
  })
})
