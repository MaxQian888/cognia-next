/**
 * @jest-environment jsdom
 */
import React from "react"
import { act, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TooltipProvider } from "@/components/ui/tooltip"

import type { LiveVoiceState } from "@/lib/voice/live/reducer"

const startMock = jest.fn()
const stopMock = jest.fn()
const muteMock = jest.fn()
const resolveSessionMock = jest.fn()
const toastErrorMock = jest.fn()
const screenLiveVoiceTextMock = jest.fn((text: string) =>
  text.includes("@") ? "Email me at [EMAIL_1]" : text
)

const IDLE: LiveVoiceState = { phase: "idle", turns: [], assistantDraft: "", muted: false }

const buildBindingsMock = jest.fn()
const persistTurnsMock = jest.fn()
/** The chat session the composer is mounted in; `undefined` = scratch pane. */
let currentSessionId: string | undefined = "chat-1"

/** Drives the controller's external store the way the real one does. */
let currentState: LiveVoiceState = IDLE
let notify: (() => void) | undefined

function publish(next: Partial<LiveVoiceState>) {
  currentState = { ...currentState, ...next }
  notify?.()
}

// `createInitialLiveVoiceState` too: `lib/voice/live/reducer` re-exports it from
// here, so mocking only the screen function leaves the hook's idle snapshot
// undefined and the suite fails at import time.
jest.mock("@/lib/voice/realtime-session", () => ({
  createInitialLiveVoiceState: () => ({
    phase: "idle",
    turns: [],
    assistantDraft: "",
    muted: false,
  }),
  screenLiveVoiceText: (text: string) => screenLiveVoiceTextMock(text),
}))

jest.mock("@/lib/voice/live/controller", () => ({
  createLiveVoiceController: jest.fn(() => ({
    subscribe: (listener: () => void) => {
      notify = listener
      return () => {
        notify = undefined
      }
    },
    getSnapshot: () => currentState,
    start: startMock,
    stop: stopMock,
    setMuted: muteMock,
  })),
}))

// `LiveVoiceUnavailableError` must be the real class — the dialog branches on
// `instanceof`, and a stub would silently take the generic error path.
jest.mock("@/lib/voice/live/session", () => {
  const actual = jest.requireActual("@/lib/voice/live/session")
  return {
    ...actual,
    resolveLiveVoiceSession: (...args: unknown[]) => resolveSessionMock(...args),
  }
})

jest.mock("@/lib/platform/detect", () => ({ isTauri: () => true }))

jest.mock("@/stores/chat/chat-store", () => ({
  useChatStore: (selector: (state: { activeSessionId?: string }) => unknown) =>
    selector({ activeSessionId: currentSessionId }),
}))

jest.mock("@/lib/voice/live/runtime-bindings", () => ({
  buildLiveVoiceRuntimeBindings: (...args: unknown[]) => buildBindingsMock(...args),
}))

jest.mock("@/lib/voice/live/persist-turns", () => ({
  persistLiveVoiceTurns: (...args: unknown[]) => persistTurnsMock(...args),
}))

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (
    selector: (state: {
      settings: Record<string, unknown>
      providerKeys: Record<string, string>
    }) => unknown
  ) =>
    selector({
      settings: {
        selectedMicId: "mic-1",
        agentPermissions: { toolRules: { search_notes: "allow" } },
        alwaysAllowTools: ["web_search"],
        liveVoice: {
          enabled: true,
          region: "global",
          fallbackEnabled: true,
          maxCandidates: 3,
          connectTimeoutMs: 10_000,
          historyTurnLimit: 12,
          historyCharacterLimit: 16_000,
          instructions: "be brief",
          deployments: [{ id: "d1", provider: "openai", region: "global", enabled: true }],
        },
      },
      providerKeys: { openai: "sk-user", xai: "xai-user" },
    }),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("sonner", () => ({
  toast: { error: (text: string) => toastErrorMock(text) },
}))

jest.mock("@/components/ai-elements/persona", () => ({
  Persona: ({ state, onLoadError }: { state: string; onLoadError?: (error: unknown) => void }) => (
    <button
      data-testid="live-voice-persona"
      data-state={state}
      onClick={() => onLoadError?.(new Error("webgl unavailable"))}
      type="button"
    />
  ),
}))

import { LiveVoiceUnavailableError } from "@/lib/voice/live/session"

import { LiveVoiceDialog } from "./live-voice-dialog"

const RESOLVED = {
  session: {
    deploymentId: "d1",
    provider: "openai",
    region: "global",
    modelOrResource: "gpt-realtime-2.1",
    token: "ek",
    url: "wss://api.openai.com/v1/realtime",
    capabilities: { inputSampleRate: 24_000, outputSampleRate: 24_000 },
  },
  adapter: { specificationVersion: "v4" },
  instructions: "be brief",
  voice: "marin",
}

function renderDialog(props: { onUserTranscript?: (text: string) => void } = {}) {
  return render(
    <TooltipProvider>
      <LiveVoiceDialog {...props} />
    </TooltipProvider>
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  currentState = IDLE
  notify = undefined
  startMock.mockResolvedValue(undefined)
  stopMock.mockResolvedValue(undefined)
  resolveSessionMock.mockResolvedValue(RESOLVED)
  currentSessionId = "chat-1"
  buildBindingsMock.mockResolvedValue({ droppedTools: [] })
  persistTurnsMock.mockResolvedValue(0)
})

describe("LiveVoiceDialog — starting a session", () => {
  it("resolves a session from settings and opens the dialog", async () => {
    const user = userEvent.setup()
    renderDialog()

    await user.click(screen.getByLabelText("startLive"))

    expect(resolveSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        instructions: "be brief",
        settings: expect.objectContaining({ enabled: true, region: "global" }),
      })
    )
    expect(startMock).toHaveBeenCalled()
    expect(screen.getByRole("dialog")).toBeInTheDocument()
  })

  it("passes only the BYOK keys of providers that can use one", async () => {
    const user = userEvent.setup()
    renderDialog()

    await user.click(screen.getByLabelText("startLive"))

    expect(resolveSessionMock.mock.calls[0][0].apiKeys).toEqual({
      openai: "sk-user",
      google: undefined,
      xai: "xai-user",
    })
  })

  it("hands the controller the screened instructions and the minting adapter", async () => {
    const { createLiveVoiceController } = jest.requireMock("@/lib/voice/live/controller")
    const user = userEvent.setup()
    renderDialog()

    await user.click(screen.getByLabelText("startLive"))

    expect(createLiveVoiceController).toHaveBeenCalledWith({
      session: RESOLVED.session,
      adapter: RESOLVED.adapter,
      instructions: "be brief",
      voice: "marin",
      deviceId: "mic-1",
    })
  })

  it("ignores a re-entrant start while a session is live", async () => {
    const user = userEvent.setup()
    renderDialog()
    await user.click(screen.getByLabelText("startLive"))

    // fireEvent rather than userEvent: the open modal puts `pointer-events:
    // none` on everything behind it, so a real second click cannot reach the
    // trigger at all. This asserts the controller-ref guard itself.
    await act(async () => {
      fireEvent.click(screen.getByLabelText("startLive"))
    })

    expect(resolveSessionMock).toHaveBeenCalledTimes(1)
  })

  it("does nothing at all when disabled", async () => {
    const user = userEvent.setup()
    render(
      <TooltipProvider>
        <LiveVoiceDialog disabled />
      </TooltipProvider>
    )

    await user.click(screen.getByLabelText("startLive"))

    expect(resolveSessionMock).not.toHaveBeenCalled()
  })
})

describe("LiveVoiceDialog — start failures", () => {
  it.each([
    ["disabled", "errors.disabled"],
    ["no-deployments", "errors.noDeployments"],
    ["none-eligible", "errors.noneEligible"],
  ])("explains an unavailable reason (%s) instead of a generic failure", async (reason, key) => {
    resolveSessionMock.mockRejectedValue(new LiveVoiceUnavailableError(reason as "disabled"))
    const user = userEvent.setup()
    renderDialog()

    await user.click(screen.getByLabelText("startLive"))

    expect(toastErrorMock).toHaveBeenCalledWith(key)
    expect(await screen.findByRole("alert")).toHaveTextContent(key)
  })

  it("reports a mint failure distinctly from a misconfiguration", async () => {
    resolveSessionMock.mockRejectedValue(new Error("every candidate refused"))
    const user = userEvent.setup()
    renderDialog()

    await user.click(screen.getByLabelText("startLive"))

    expect(toastErrorMock).toHaveBeenCalledWith("errors.mintFailed")
  })

  it("lets the user close and retry after a failed start", async () => {
    // A half-built controller left in the ref would make the retry a silent
    // no-op with the dialog stuck showing the previous error.
    resolveSessionMock.mockRejectedValueOnce(new Error("transient"))
    const user = userEvent.setup()
    renderDialog()

    await user.click(screen.getByLabelText("startLive"))
    await user.click(screen.getByLabelText("end"))
    await user.click(screen.getByLabelText("startLive"))

    expect(resolveSessionMock).toHaveBeenCalledTimes(2)
    expect(startMock).toHaveBeenCalledTimes(1)
  })

  it("clears the previous error when a retry begins", async () => {
    resolveSessionMock.mockRejectedValueOnce(new LiveVoiceUnavailableError("no-deployments"))
    const user = userEvent.setup()
    renderDialog()

    await user.click(screen.getByLabelText("startLive"))
    expect(await screen.findByRole("alert")).toHaveTextContent("errors.noDeployments")

    await user.click(screen.getByLabelText("end"))
    await user.click(screen.getByLabelText("startLive"))

    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("tears down a controller whose start throws", async () => {
    startMock.mockRejectedValue(new Error("microphone denied"))
    const user = userEvent.setup()
    renderDialog()

    await user.click(screen.getByLabelText("startLive"))

    expect(stopMock).toHaveBeenCalled()
    expect(toastErrorMock).toHaveBeenCalledWith("errors.mintFailed")
  })
})

describe("LiveVoiceDialog — live conversation", () => {
  it("maps live phases to Persona states and falls back after a render failure", async () => {
    const user = userEvent.setup()
    renderDialog()
    await user.click(screen.getByLabelText("startLive"))

    act(() => publish({ phase: "responding" }))
    const persona = screen.getByTestId("live-voice-persona")
    expect(persona).toHaveAttribute("data-state", "speaking")

    await user.click(persona)
    expect(screen.getByTestId("live-voice-persona-fallback")).toBeInTheDocument()
  })

  it("renders transcripts and forwards completed user turns", async () => {
    const user = userEvent.setup()
    const onUserTranscript = jest.fn()
    renderDialog({ onUserTranscript })
    await user.click(screen.getByLabelText("startLive"))

    act(() => {
      publish({
        phase: "responding",
        assistantDraft: "Working…",
        turns: [{ id: "u1", role: "user", text: "Check the build" }],
      })
    })

    expect(await screen.findByText("Check the build")).toBeInTheDocument()
    expect(screen.getByText("Working…")).toBeInTheDocument()
    expect(onUserTranscript).toHaveBeenCalledWith("Check the build")
  })

  it("forwards each user turn only once as state keeps updating", async () => {
    const user = userEvent.setup()
    const onUserTranscript = jest.fn()
    renderDialog({ onUserTranscript })
    await user.click(screen.getByLabelText("startLive"))

    act(() => {
      publish({ turns: [{ id: "u1", role: "user", text: "hello" }] })
    })
    act(() => {
      publish({
        turns: [
          { id: "u1", role: "user", text: "hello" },
          { id: "a1", role: "assistant", text: "hi" },
        ],
      })
    })

    expect(onUserTranscript).toHaveBeenCalledTimes(1)
  })

  it("screens a user transcript again before forwarding it to the composer", async () => {
    // The transcript is model output, not the persona gated at mint time.
    const user = userEvent.setup()
    const onUserTranscript = jest.fn()
    renderDialog({ onUserTranscript })
    await user.click(screen.getByLabelText("startLive"))

    act(() => {
      publish({
        phase: "listening",
        turns: [{ id: "u-sensitive", role: "user", text: "Email me at alex@example.com" }],
      })
    })

    expect(onUserTranscript).toHaveBeenCalledWith("Email me at [EMAIL_1]")
    expect(onUserTranscript).not.toHaveBeenCalledWith(expect.stringContaining("alex@example.com"))
  })

  it("surfaces a mid-session error", async () => {
    const user = userEvent.setup()
    renderDialog()
    await user.click(screen.getByLabelText("startLive"))

    act(() => {
      publish({ phase: "error", error: "socket closed" })
    })

    expect(await screen.findByRole("alert")).toHaveTextContent("errors.sessionFailed")
  })

  it("supports mute and ends the session when closed", async () => {
    const user = userEvent.setup()
    renderDialog()
    await user.click(screen.getByLabelText("startLive"))

    await user.click(screen.getByLabelText("mute"))
    expect(muteMock).toHaveBeenCalledWith(true)

    act(() => {
      publish({ muted: true })
    })
    await user.click(screen.getByLabelText("unmute"))
    expect(muteMock).toHaveBeenLastCalledWith(false)

    await user.click(screen.getByLabelText("end"))
    expect(stopMock).toHaveBeenCalled()
  })

  it("disables mute while no controller exists", async () => {
    // The dialog stays open after a failed start; muting a session that never
    // opened would throw on a null ref.
    resolveSessionMock.mockRejectedValue(new Error("transient"))
    const user = userEvent.setup()
    renderDialog()

    await user.click(screen.getByLabelText("startLive"))

    expect(screen.getByLabelText("mute")).toBeDisabled()
  })

  it("stops the session when the component unmounts mid-call", async () => {
    const user = userEvent.setup()
    const { unmount } = renderDialog()
    await user.click(screen.getByLabelText("startLive"))

    unmount()

    expect(stopMock).toHaveBeenCalled()
  })
})

describe("LiveVoiceDialog — tools and context", () => {
  it("resolves tools and history for the active chat session", async () => {
    const user = userEvent.setup()
    renderDialog()

    await user.click(screen.getByLabelText("startLive"))

    expect(buildBindingsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "chat-1",
        capabilities: RESOLVED.session.capabilities,
        limits: { turnLimit: 12, characterLimit: 16_000 },
      })
    )
  })

  it("passes the user's tool permissions to the runtime", async () => {
    // Voice resolves permissions itself; handing it the wrong policy is how
    // "always allow" silently stops working.
    const user = userEvent.setup()
    renderDialog()

    await user.click(screen.getByLabelText("startLive"))

    expect(buildBindingsMock.mock.calls[0][0].policy).toEqual({
      toolRules: { search_notes: "allow" },
      alwaysAllowTools: ["web_search"],
    })
  })

  it("hands the controller the tools, executor and conversation seed", async () => {
    const { createLiveVoiceController } = jest.requireMock("@/lib/voice/live/controller")
    const toolExecution = { sessionId: "chat-1", policy: {}, execute: jest.fn() }
    const tools = [{ type: "function", name: "search_notes", parameters: {} }]
    buildBindingsMock.mockResolvedValue({
      tools,
      toolExecution,
      contextTranscript: "User: who won",
      droppedTools: [],
    })
    const user = userEvent.setup()
    renderDialog()

    await user.click(screen.getByLabelText("startLive"))

    expect(createLiveVoiceController).toHaveBeenCalledWith(
      expect.objectContaining({ tools, toolExecution, contextTranscript: "User: who won" })
    )
  })
})

describe("LiveVoiceDialog — archiving the conversation", () => {
  const TURNS = [
    { id: "item_1", role: "user" as const, text: "who won" },
    { id: "item_2", role: "assistant" as const, text: "the badgers" },
  ]

  it("writes the finished turns into the chat history", async () => {
    const user = userEvent.setup()
    renderDialog()
    await user.click(screen.getByLabelText("startLive"))
    act(() => publish({ turns: TURNS }))

    await user.click(screen.getByLabelText("end"))

    expect(persistTurnsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "chat-1",
        turns: TURNS,
        provenance: {
          provider: "openai",
          modelOrResource: "gpt-realtime-2.1",
          region: "global",
        },
      })
    )
  })

  it("reads the transcript before stopping, since stop resets the state", async () => {
    const user = userEvent.setup()
    renderDialog()
    await user.click(screen.getByLabelText("startLive"))
    act(() => publish({ turns: TURNS }))

    await user.click(screen.getByLabelText("end"))

    expect(persistTurnsMock.mock.calls[0][0].turns).toHaveLength(2)
  })

  it("writes nothing for a session where nobody spoke", async () => {
    const user = userEvent.setup()
    renderDialog()
    await user.click(screen.getByLabelText("startLive"))

    await user.click(screen.getByLabelText("end"))

    expect(persistTurnsMock).not.toHaveBeenCalled()
  })

  it("archives nothing when the composer has no chat session", async () => {
    currentSessionId = undefined
    const user = userEvent.setup()
    renderDialog()
    await user.click(screen.getByLabelText("startLive"))
    act(() => publish({ turns: TURNS }))

    await user.click(screen.getByLabelText("end"))

    expect(persistTurnsMock).not.toHaveBeenCalled()
  })

  it("still closes the dialog when archiving fails", async () => {
    // The conversation happened; failing to file it must not strand the user
    // in a dead call UI.
    persistTurnsMock.mockRejectedValue(new Error("dexie is closed"))
    const user = userEvent.setup()
    renderDialog()
    await user.click(screen.getByLabelText("startLive"))
    act(() => publish({ turns: TURNS }))

    await user.click(screen.getByLabelText("end"))

    expect(stopMock).toHaveBeenCalled()
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })
})
