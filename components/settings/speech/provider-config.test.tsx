/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

const saveMock = jest.fn()
jest.mock("@/lib/tauri", () => ({ isTauri: () => false }))

jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T,>(
    selector: (s: {
      settings: Record<string, unknown>
      providerKeys: Record<string, string>
      save: typeof saveMock
    }) => T
  ): T =>
    selector({
      settings: { realtimeVoice: "marin", realtimeModel: "gpt-realtime" },
      providerKeys: {},
      save: saveMock,
    }),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("./api-key-input", () => ({
  ApiKeyInput: ({ label }: { label: string }) => <div data-testid="api-key">{label}</div>,
}))

import {
  LocalOpenAiCompatibleConfig,
  MistralConfig,
  PROVIDER_CONFIG_COMPONENTS,
} from "./provider-config"

beforeEach(() => {
  saveMock.mockClear()
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

describe("LocalOpenAiCompatibleConfig", () => {
  it("registers one generic local provider and persists its endpoint", () => {
    expect(PROVIDER_CONFIG_COMPONENTS["local-openai-compatible"]).toBe(LocalOpenAiCompatibleConfig)
    render(<LocalOpenAiCompatibleConfig />)
    fireEvent.change(screen.getByPlaceholderText("localEndpointPlaceholder"), {
      target: { value: "http://127.0.0.1:8880/v1" },
    })
    expect(saveMock).toHaveBeenCalledWith({
      localOpenaiBaseUrl: "http://127.0.0.1:8880/v1",
    })
    expect(screen.getByTestId("api-key")).toHaveTextContent("label.local-openai-compatible")
  })
})
