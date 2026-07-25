/**
 * @jest-environment jsdom
 */
import React from "react"
import { fireEvent, render, screen } from "@testing-library/react"

const saveMock = jest.fn()

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (
    selector: (state: { settings: Record<string, unknown>; save: jest.Mock }) => unknown
  ) =>
    selector({
      settings: {
        realtimeModel: "gpt-realtime-2.1",
        realtimeVoice: "marin",
        realtimeInstructions: "",
      },
      save: saveMock,
    }),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("./api-key-input", () => ({
  ApiKeyInput: ({ provider }: { provider: string }) => (
    <div data-testid="api-key-provider">{provider}</div>
  ),
}))

import { LiveVoiceCard } from "./live-voice-card"

describe("LiveVoiceCard", () => {
  beforeEach(() => jest.clearAllMocks())

  it("uses the OpenAI key and exposes current model and voice settings", () => {
    render(<LiveVoiceCard />)
    expect(screen.getByTestId("api-key-provider")).toHaveTextContent("openai")
    expect(screen.getByText("GPT Realtime 2.1")).toBeInTheDocument()
    expect(screen.getByText("Marin")).toBeInTheDocument()
  })

  it("persists custom live instructions", () => {
    render(<LiveVoiceCard />)
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Be brief" } })
    expect(saveMock).toHaveBeenLastCalledWith({ realtimeInstructions: "Be brief" })
  })
})
