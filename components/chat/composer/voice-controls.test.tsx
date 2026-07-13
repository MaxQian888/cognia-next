/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("sonner", () => ({
  toast: { error: jest.fn(), info: jest.fn() },
}))

jest.mock("@/components/ai-elements/speech-input", () => ({
  SpeechInput: (props: Record<string, unknown>) => {
    const onListeningChange = props.onListeningChange as ((listening: boolean) => void) | undefined
    const onError = props.onError as ((error: string) => void) | undefined
    return (
      <>
        <button
          data-testid="speech-input"
          aria-label={String(props["aria-label"] ?? "")}
          onClick={() => onListeningChange?.(true)}
        >
          mic
        </button>
        <button data-testid="speech-error-not-allowed" onClick={() => onError?.("not-allowed")} />
        <button data-testid="speech-error-no-speech" onClick={() => onError?.("no-speech")} />
        <button
          data-testid="speech-error-audio-capture"
          onClick={() => onError?.("audio-capture")}
        />
        <button data-testid="speech-error-generic" onClick={() => onError?.("network")} />
      </>
    )
  },
}))

type MicPermission = {
  state: "granted" | "denied" | "prompt" | "unknown"
  loading: boolean
  request: jest.Mock
}

const micPermission: MicPermission = { loading: false, request: jest.fn(), state: "prompt" }
const micDevices: MediaDeviceInfo[] = []

jest.mock("@/components/ai-elements/mic-selector", () => ({
  MicSelector: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="mic-selector">{children}</div>
  ),
  MicSelectorContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MicSelectorEmpty: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="mic-empty">{children}</div>
  ),
  MicSelectorInput: () => <input data-testid="mic-search" />,
  MicSelectorItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MicSelectorLabel: () => <span>label</span>,
  MicSelectorList: ({
    children,
  }: {
    children: (devices: MediaDeviceInfo[], permission: MicPermission) => React.ReactNode
  }) => <>{children(micDevices, micPermission)}</>,
  MicSelectorRequestAccess: ({ children }: { children: React.ReactNode }) => (
    <button data-testid="mic-request-access">{children}</button>
  ),
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

jest.mock("@cognia/tts/speech", () => ({
  DEFAULT_SPEECH_LANGUAGE: "en-US",
  SPEECH_LANGUAGES: [
    { code: "en-US", name: "English", flag: "🇺🇸" },
    { code: "zh-CN", name: "Chinese", flag: "🇨🇳" },
  ],
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
}))

import { toast } from "sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { VoiceControls } from "./voice-controls"

const toastError = toast.error as jest.Mock
const toastInfo = toast.info as jest.Mock

const renderWithTooltipProvider = (ui: React.ReactElement) =>
  render(<TooltipProvider>{ui}</TooltipProvider>)

describe("VoiceControls", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    micPermission.state = "prompt"
    micDevices.length = 0
  })

  it("renders both the SpeechInput button and the settings popover trigger", () => {
    renderWithTooltipProvider(<VoiceControls onTranscription={() => {}} />)
    expect(screen.getByTestId("speech-input")).toBeInTheDocument()
    expect(screen.getByLabelText("voiceSettings")).toBeInTheDocument()
  })

  it("forwards the disabled flag to the speech input", () => {
    renderWithTooltipProvider(<VoiceControls onTranscription={() => {}} disabled />)
    expect(screen.getByLabelText("voiceSettings")).toBeDisabled()
  })

  it("shows a live listening indicator and swaps the aria label while recording", async () => {
    const user = userEvent.setup()
    renderWithTooltipProvider(<VoiceControls onTranscription={() => {}} />)

    expect(screen.queryByRole("status")).not.toBeInTheDocument()
    expect(screen.getByTestId("speech-input")).toHaveAttribute("aria-label", "startListening")

    await user.click(screen.getByTestId("speech-input"))

    const status = screen.getByRole("status")
    expect(status).toHaveTextContent("listening")
    expect(screen.getByTestId("speech-input")).toHaveAttribute("aria-label", "stopListening")
  })

  it("maps speech errors to localized toasts", async () => {
    const user = userEvent.setup()
    renderWithTooltipProvider(<VoiceControls onTranscription={() => {}} />)

    await user.click(screen.getByTestId("speech-error-not-allowed"))
    expect(toastError).toHaveBeenCalledWith("errors.permissionDenied")

    await user.click(screen.getByTestId("speech-error-no-speech"))
    expect(toastInfo).toHaveBeenCalledWith("errors.noSpeech")

    await user.click(screen.getByTestId("speech-error-audio-capture"))
    expect(toastError).toHaveBeenCalledWith("errors.noMicrophone")

    await user.click(screen.getByTestId("speech-error-generic"))
    expect(toastError).toHaveBeenCalledWith("errors.generic")
  })

  const openSettingsPopover = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByLabelText("voiceSettings"))
  }

  it("offers an explicit grant-access button when permission has not been granted", async () => {
    const user = userEvent.setup()
    micPermission.state = "prompt"
    renderWithTooltipProvider(<VoiceControls onTranscription={() => {}} />)
    await openSettingsPopover(user)
    expect(screen.getByTestId("mic-request-access")).toHaveTextContent("grantMicAccess")
  })

  it("shows a denied hint instead of the grant button when permission is denied", async () => {
    const user = userEvent.setup()
    micPermission.state = "denied"
    renderWithTooltipProvider(<VoiceControls onTranscription={() => {}} />)
    await openSettingsPopover(user)
    expect(screen.queryByTestId("mic-request-access")).not.toBeInTheDocument()
    expect(screen.getByText("micPermissionDenied")).toBeInTheDocument()
  })

  it("hides the grant button once devices are labelled (permission granted)", async () => {
    const user = userEvent.setup()
    micPermission.state = "granted"
    micDevices.push({
      deviceId: "abc",
      groupId: "g",
      kind: "audioinput",
      label: "Built-in Microphone",
      toJSON: () => ({}),
    } as MediaDeviceInfo)
    renderWithTooltipProvider(<VoiceControls onTranscription={() => {}} />)
    await openSettingsPopover(user)
    expect(screen.queryByTestId("mic-request-access")).not.toBeInTheDocument()
  })
})
