/**
 * @jest-environment jsdom
 */
import React from "react"
import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TooltipProvider } from "@/components/ui/tooltip"

const startMock = jest.fn()
const stopMock = jest.fn()
const muteMock = jest.fn()
const screenLiveVoiceTextMock = jest.fn((text: string) =>
  text.includes("@") ? "Email me at [EMAIL_1]" : text
)
let emitState: ((state: Record<string, unknown>) => void) | undefined

jest.mock("@/lib/voice/realtime-session", () => ({
  createInitialLiveVoiceState: () => ({
    phase: "idle",
    turns: [],
    assistantDraft: "",
    muted: false,
  }),
  RealtimeVoiceSession: jest.fn().mockImplementation((listener) => {
    emitState = listener
    return { setMuted: muteMock, start: startMock, stop: stopMock }
  }),
  screenLiveVoiceText: (text: string) => screenLiveVoiceTextMock(text),
}))

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: { settings: Record<string, unknown> }) => unknown) =>
    selector({
      settings: {
        realtimeModel: "gpt-realtime-2.1",
        realtimeVoice: "marin",
        realtimeInstructions: "",
        selectedMicId: "mic-1",
      },
    }),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("sonner", () => ({
  toast: { error: jest.fn() },
}))

import { LiveVoiceDialog } from "./live-voice-dialog"

describe("LiveVoiceDialog", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    startMock.mockResolvedValue(undefined)
  })

  it("starts a configured realtime session from the toolbar", async () => {
    const user = userEvent.setup()
    render(
      <TooltipProvider>
        <LiveVoiceDialog />
      </TooltipProvider>
    )

    await user.click(screen.getByLabelText("startLive"))

    expect(startMock).toHaveBeenCalledWith({
      instructions: "",
      microphoneId: "mic-1",
      model: "gpt-realtime-2.1",
      voice: "marin",
    })
    expect(screen.getByRole("dialog")).toBeInTheDocument()
  })

  it("renders transcripts and forwards completed user turns", async () => {
    const user = userEvent.setup()
    const onUserTranscript = jest.fn()
    render(
      <TooltipProvider>
        <LiveVoiceDialog onUserTranscript={onUserTranscript} />
      </TooltipProvider>
    )
    await user.click(screen.getByLabelText("startLive"))

    act(() => {
      emitState?.({
        phase: "responding",
        muted: false,
        assistantDraft: "Working…",
        turns: [{ id: "u1", role: "user", text: "Check the build" }],
      })
    })

    expect(await screen.findByText("Check the build")).toBeInTheDocument()
    expect(screen.getByText("Working…")).toBeInTheDocument()
    expect(onUserTranscript).toHaveBeenCalledWith("Check the build")
  })

  it("screens a user transcript again before forwarding it to the composer", async () => {
    const user = userEvent.setup()
    const onUserTranscript = jest.fn()
    render(
      <TooltipProvider>
        <LiveVoiceDialog onUserTranscript={onUserTranscript} />
      </TooltipProvider>
    )
    await user.click(screen.getByLabelText("startLive"))

    act(() => {
      emitState?.({
        phase: "listening",
        muted: false,
        assistantDraft: "",
        turns: [{ id: "u-sensitive", role: "user", text: "Email me at alex@example.com" }],
      })
    })

    expect(onUserTranscript).toHaveBeenCalledWith("Email me at [EMAIL_1]")
    expect(onUserTranscript).not.toHaveBeenCalledWith(expect.stringContaining("alex@example.com"))
  })

  it("supports mute and ends the media session when closed", async () => {
    const user = userEvent.setup()
    render(
      <TooltipProvider>
        <LiveVoiceDialog />
      </TooltipProvider>
    )
    await user.click(screen.getByLabelText("startLive"))
    await user.click(screen.getByLabelText("mute"))
    expect(muteMock).toHaveBeenCalledWith(true)

    await user.click(screen.getByLabelText("end"))
    expect(stopMock).toHaveBeenCalled()
  })
})
