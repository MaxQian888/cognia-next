/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen } from "@testing-library/react"

jest.mock("@/components/ai-elements/speech-input", () => ({
  SpeechInput: (props: Record<string, unknown>) => (
    <button data-testid="speech-input" aria-label={String(props["aria-label"] ?? "")}>
      mic
    </button>
  ),
}))

jest.mock("@/components/ai-elements/mic-selector", () => ({
  MicSelector: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="mic-selector">{children}</div>
  ),
  MicSelectorContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MicSelectorEmpty: () => <div data-testid="mic-empty" />,
  MicSelectorInput: () => <input data-testid="mic-search" />,
  MicSelectorItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MicSelectorLabel: () => <span>label</span>,
  MicSelectorList: ({
    children,
  }: {
    children: (devices: MediaDeviceInfo[]) => React.ReactNode
  }) => <>{children([])}</>,
  MicSelectorTrigger: ({ children }: { children: React.ReactNode }) => (
    <button data-testid="mic-trigger">{children}</button>
  ),
  MicSelectorValue: () => <span>value</span>,
}))

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (
    selector: (s: { settings?: Record<string, unknown>; save: jest.Mock }) => unknown
  ) => selector({ settings: undefined, save: jest.fn() }),
}))

jest.mock("@/lib/tts/speech", () => ({
  DEFAULT_SPEECH_LANGUAGE: "en-US",
  SPEECH_LANGUAGES: [
    { code: "en-US", name: "English", flag: "🇺🇸" },
    { code: "zh-CN", name: "Chinese", flag: "🇨🇳" },
  ],
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
}))

import { TooltipProvider } from "@/components/ui/tooltip"
import { VoiceControls } from "./voice-controls"

const renderWithTooltipProvider = (ui: React.ReactElement) =>
  render(<TooltipProvider>{ui}</TooltipProvider>)

describe("VoiceControls", () => {
  it("renders both the SpeechInput button and the settings popover trigger", () => {
    renderWithTooltipProvider(<VoiceControls onTranscription={() => {}} />)
    expect(screen.getByTestId("speech-input")).toBeInTheDocument()
    expect(screen.getByLabelText("voiceSettings")).toBeInTheDocument()
  })

  it("forwards the disabled flag to the speech input", () => {
    renderWithTooltipProvider(<VoiceControls onTranscription={() => {}} disabled />)
    expect(screen.getByLabelText("voiceSettings")).toBeDisabled()
  })
})
