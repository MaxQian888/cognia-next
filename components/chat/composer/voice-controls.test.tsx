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
  detectSpeechInputMode: () =>
    ((globalThis as Record<string, unknown>).__mockSpeechMode as string | undefined) ??
    "speech-recognition",
  SpeechInput: (props: Record<string, unknown>) => {
    const onListeningChange = props.onListeningChange as ((listening: boolean) => void) | undefined
    const onError = props.onError as ((error: string) => void) | undefined
    return (
      <>
        <button
          data-testid="speech-input"
          data-lang={props.lang as string | undefined}
          data-voice-trigger={props["data-voice-trigger"] as string | undefined}
          aria-label={String(props["aria-label"] ?? "")}
          onClick={() => {
            // A WebView recognizer that never fires `start` (the on-device bug).
            if ((globalThis as Record<string, unknown>).__mockSpeechDeadStart) return
            onListeningChange?.(true)
          }}
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

// `mockSettings` is read lazily inside the selector, so each test can flip it.
let mockSettings: Record<string, unknown> | undefined = undefined
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (
    selector: (s: {
      settings?: Record<string, unknown>
      save: jest.Mock
      ensureProviderKeys: jest.Mock
    }) => unknown
  ) => selector({ settings: mockSettings, save: jest.fn(), ensureProviderKeys: jest.fn() }),
}))

// Live voice is its own surface with its own suite; here it only has to exist.
jest.mock("./live-voice-dialog", () => ({
  LiveVoiceDialog: () => null,
}))

jest.mock("@cognia/tts/speech", () => ({
  resolveSttLanguage: jest.requireActual("@cognia/tts/speech").resolveSttLanguage,
  DEFAULT_SPEECH_LANGUAGE: "en-US",
  SPEECH_LANGUAGES: [
    { code: "en-US", name: "English", flag: "🇺🇸" },
    { code: "zh-CN", name: "Chinese", flag: "🇨🇳" },
  ],
}))

const platformRef = { current: "web" }
jest.mock("@/hooks/use-platform", () => ({ usePlatform: () => platformRef.current }))

jest.mock("@/lib/capacitor/microphone", () => ({ ensureMicrophonePermission: jest.fn() }))
jest.mock("@/lib/capacitor/app-settings", () => ({ openAppSettings: jest.fn() }))

jest.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
}))

import { act } from "@testing-library/react"
import { toast } from "sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { openAppSettings } from "@/lib/capacitor/app-settings"
import { ensureMicrophonePermission } from "@/lib/capacitor/microphone"
import { VOICE_START_TIMEOUT_MS, VoiceControls } from "./voice-controls"

const ensureMicMock = ensureMicrophonePermission as jest.Mock

const toastError = toast.error as jest.Mock
const toastInfo = toast.info as jest.Mock

const renderWithTooltipProvider = (ui: React.ReactElement) =>
  render(<TooltipProvider>{ui}</TooltipProvider>)

describe("VoiceControls", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSettings = undefined
    micPermission.state = "prompt"
    micDevices.length = 0
    delete (globalThis as Record<string, unknown>).__mockSpeechMode
    delete (globalThis as Record<string, unknown>).__mockSpeechDeadStart
    platformRef.current = "web"
  })

  describe("on the native mobile shell", () => {
    beforeEach(() => {
      platformRef.current = "mobile"
    })

    it("asks for the microphone first, then starts dictation", async () => {
      ensureMicMock.mockResolvedValue({ kind: "ok", value: "granted" })
      const user = userEvent.setup()
      renderWithTooltipProvider(<VoiceControls onTranscription={() => {}} />)

      await user.click(screen.getByTestId("speech-input"))

      expect(ensureMicMock).toHaveBeenCalledTimes(1)
      expect(await screen.findByRole("status")).toHaveTextContent("listening")

      // Granted once: the next start goes straight to recognition.
      await user.click(screen.getByTestId("speech-input"))
      expect(ensureMicMock).toHaveBeenCalledTimes(1)
    })

    it("says the microphone was denied and offers the app settings", async () => {
      ensureMicMock.mockResolvedValue({ kind: "ok", value: "denied" })
      const user = userEvent.setup()
      renderWithTooltipProvider(<VoiceControls onTranscription={() => {}} />)

      await user.click(screen.getByTestId("speech-input"))

      expect(toastError).toHaveBeenCalledWith(
        "errors.permissionDenied",
        expect.objectContaining({ action: expect.objectContaining({ label: "openSettings" }) })
      )
      expect(screen.queryByRole("status")).not.toBeInTheDocument()
      const { action } = toastError.mock.calls[0][1] as { action: { onClick: () => void } }
      action.onClick()
      expect(openAppSettings).toHaveBeenCalled()
    })

    it("reports a start that never reaches the listening state", async () => {
      jest.useFakeTimers()
      try {
        ;(globalThis as Record<string, unknown>).__mockSpeechDeadStart = true
        ensureMicMock.mockResolvedValue({ kind: "ok", value: "granted" })
        const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime })
        renderWithTooltipProvider(<VoiceControls onTranscription={() => {}} />)

        await user.click(screen.getByTestId("speech-input"))
        expect(toastError).not.toHaveBeenCalled()
        act(() => {
          jest.advanceTimersByTime(VOICE_START_TIMEOUT_MS)
        })
        expect(toastError).toHaveBeenCalledWith("errors.notStarted")
      } finally {
        jest.useRealTimers()
      }
    })

    it("does not ask for the microphone off the native shell", async () => {
      platformRef.current = "web"
      const user = userEvent.setup()
      renderWithTooltipProvider(<VoiceControls onTranscription={() => {}} />)
      await user.click(screen.getByTestId("speech-input"))
      expect(ensureMicMock).not.toHaveBeenCalled()
      expect(screen.getByRole("status")).toBeInTheDocument()
    })
  })

  it("dictates in the app language until the user picks one", () => {
    // A zh-CN UI listened in en-US and transcribed Chinese speech as English.
    mockSettings = { language: "zh-CN" }
    const { unmount } = renderWithTooltipProvider(<VoiceControls onTranscription={() => {}} />)
    expect(screen.getByTestId("speech-input")).toHaveAttribute("data-lang", "zh-CN")
    unmount()

    mockSettings = { language: "zh-CN", sttLanguage: "en-US" }
    renderWithTooltipProvider(<VoiceControls onTranscription={() => {}} />)
    expect(screen.getByTestId("speech-input")).toHaveAttribute("data-lang", "en-US")
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

  it("labels the mic as unsupported when Speech Recognition is unavailable", () => {
    ;(globalThis as Record<string, unknown>).__mockSpeechMode = "none"
    renderWithTooltipProvider(<VoiceControls onTranscription={() => {}} />)
    const input = screen.getByTestId("speech-input")
    expect(input).toHaveAttribute("aria-label", "errors.unsupported")
    // The disabled button is wrapped so the tooltip explaining why can fire.
    expect(input.parentElement?.tagName).toBe("SPAN")
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

  // Dictation is Web Speech, which always records from the system default
  // input; only live voice honours a picked device.
  it("leaves the microphone picker out while live voice is off", async () => {
    const user = userEvent.setup()
    renderWithTooltipProvider(<VoiceControls onTranscription={() => {}} />)
    await openSettingsPopover(user)
    expect(screen.queryByTestId("voice-settings-microphone")).not.toBeInTheDocument()
    expect(screen.queryByTestId("mic-trigger")).not.toBeInTheDocument()
    expect(screen.getByText("languageLabel")).toBeInTheDocument()
  })

  it("offers the microphone picker, and says what it drives, with live voice on", async () => {
    const user = userEvent.setup()
    mockSettings = { liveVoice: { enabled: true } }
    renderWithTooltipProvider(<VoiceControls onTranscription={() => {}} />)
    await openSettingsPopover(user)
    expect(screen.getByTestId("voice-settings-microphone")).toHaveTextContent("microphoneLiveOnly")
    expect(screen.getByTestId("mic-trigger")).toBeInTheDocument()
  })

  it("offers an explicit grant-access button when permission has not been granted", async () => {
    const user = userEvent.setup()
    mockSettings = { liveVoice: { enabled: true } }
    micPermission.state = "prompt"
    renderWithTooltipProvider(<VoiceControls onTranscription={() => {}} />)
    await openSettingsPopover(user)
    expect(screen.getByTestId("mic-request-access")).toHaveTextContent("grantMicAccess")
  })

  it("shows a denied hint instead of the grant button when permission is denied", async () => {
    const user = userEvent.setup()
    mockSettings = { liveVoice: { enabled: true } }
    micPermission.state = "denied"
    renderWithTooltipProvider(<VoiceControls onTranscription={() => {}} />)
    await openSettingsPopover(user)
    expect(screen.queryByTestId("mic-request-access")).not.toBeInTheDocument()
    expect(screen.getByText("micPermissionDenied")).toBeInTheDocument()
  })

  it("hides the grant button once devices are labelled (permission granted)", async () => {
    const user = userEvent.setup()
    mockSettings = { liveVoice: { enabled: true } }
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
