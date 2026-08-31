/**
 * @jest-environment jsdom
 */
import { act, render, waitFor } from "@testing-library/react"

import { SelectionToolbarInitializer } from "./selection-toolbar-initializer"

const handlers = new Map<string, (event: { payload: unknown }) => void>()
const takePendingStageMock = jest.fn()
const getCurrentCandidateMock = jest.fn()
const emitToMock = jest.fn().mockResolvedValue(undefined)
jest.mock("@tauri-apps/api/event", () => ({
  listen: jest.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
    handlers.set(event, handler)
    return jest.fn()
  }),
  emitTo: (...args: unknown[]) => emitToMock(...args),
}))

jest.mock("@/lib/tauri/selection-toolbar", () => ({
  SELECTION_STAGE_EVENT: "selection://stage",
  SELECTION_RESULT_EVENT: "selection://result",
  SELECTION_SPEECH_EVENT: "selection://speech",
  SELECTION_SPEECH_STOP_EVENT: "selection://speech-stop",
  SELECTION_CANDIDATE_EVENT: "selection://candidate",
  SELECTION_ACTION_CATALOG_EVENT: "selection://action-catalog",
  SELECTION_ACTION_REQUEST_EVENT: "selection://action-request",
  SELECTION_ACTION_RESULT_EVENT: "selection://action-result",
  SELECTION_OPEN_RESULT_EVENT: "selection://open-result",
  SELECTION_DIRECT_REPLACE_ALLOWLIST_PREF: "selectionToolbar.directReplaceAllowlist.v1",
  SELECTION_TOOLBAR_LABEL: "selection-toolbar",
  takePendingSelectionStage: () => takePendingStageMock(),
  getCurrentSelectionCandidate: () => getCurrentCandidateMock(),
}))

const listQuickActionsMock = jest.fn()
const getQuickActionMock = jest.fn()
const unsubscribeQuickActionsMock = jest.fn()
jest.mock("@/lib/plugin/registries/quick-action-registry", () => ({
  listQuickActions: (...args: unknown[]) => listQuickActionsMock(...args),
  getQuickAction: (...args: unknown[]) => getQuickActionMock(...args),
  subscribeQuickActions: () => unsubscribeQuickActionsMock,
}))

jest.mock("@/lib/selection/plugin-actions", () => ({
  executePluginSelectionQuickAction: jest.fn(),
  SelectionQuickActionError: class extends Error {
    constructor(
      public code: string,
      message: string
    ) {
      super(message)
    }
  },
}))
import { executePluginSelectionQuickAction } from "@/lib/selection/plugin-actions"
const executePluginSelectionQuickActionMock = executePluginSelectionQuickAction as jest.Mock

jest.mock("@/lib/i18n/plugin-i18n-registry", () => ({
  lookupPluginMessage: () => undefined,
}))

jest.mock("@/lib/tauri/store", () => ({
  getPref: jest.fn(async () => []),
}))

const storeExternalMemoryMock = jest.fn()
jest.mock("@/lib/memory/api/store-memory", () => ({
  storeExternalMemory: (...args: unknown[]) => storeExternalMemoryMock(...args),
}))

const speakSelectionMock = jest.fn()
const stopSelectionSpeechMock = jest.fn()
let speechSubscriber: ((update: { playing: boolean; progress?: number }) => void) | null = null
const unwatchMock = jest.fn()
jest.mock("@/lib/tts/speak-selection", () => ({
  speakSelection: (...args: unknown[]) => speakSelectionMock(...args),
  stopSelectionSpeech: (...args: unknown[]) => stopSelectionSpeechMock(...args),
  watchSelectionSpeech: (
    _candidateId: string,
    onChange: (update: { playing: boolean; progress?: number }) => void
  ) => {
    speechSubscriber = onChange
    return unwatchMock
  },
}))

const pushMock = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}))

jest.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: () => (key: string, vars?: Record<string, string>) =>
    vars?.language ? `${key}:${vars.language}` : key,
}))

const startNewSessionMock = jest.fn()
jest.mock("@/lib/chat/start-session", () => ({
  startNewSession: () => startNewSessionMock(),
}))

import { useChatStore } from "@/stores/chat"
import { useComposerIntentStore } from "@/stores/chat/composer-intent-store"

const candidate = {
  id: "candidate-1",
  text: "selected text",
  sourceApp: "TextEdit",
  sourceTitle: "Draft",
  origin: "accessibility",
  capturedAt: 1,
  truncated: false,
  editable: true,
  replaceCapability: "paste",
}

const stage = () => handlers.get("selection://stage")

beforeEach(() => {
  handlers.clear()
  speechSubscriber = null
  jest.clearAllMocks()
  takePendingStageMock.mockResolvedValue(null)
  getCurrentCandidateMock.mockResolvedValue(null)
  listQuickActionsMock.mockReturnValue([])
  getQuickActionMock.mockReturnValue(undefined)
  executePluginSelectionQuickActionMock.mockResolvedValue(undefined)
  storeExternalMemoryMock.mockResolvedValue({ ok: true, stored: true, consolidated: false })
  speakSelectionMock.mockResolvedValue(undefined)
  useChatStore.getState().clear()
  useComposerIntentStore.setState({ pendingBySession: {} })
})

it("publishes eligible plugin descriptors and executes them only in the main window", async () => {
  const entry = {
    fullId: "plug-a:summarize",
    pluginId: "plug-a",
    id: "summarize",
    title: "Summarize",
    surfaces: ["selection"],
    commandId: "_qa:plug-a:summarize",
    selection: { input: "text", output: "preview" },
  }
  listQuickActionsMock.mockReturnValue([entry])
  getQuickActionMock.mockReturnValue(entry)
  getCurrentCandidateMock.mockResolvedValue(candidate)
  executePluginSelectionQuickActionMock.mockResolvedValue({ kind: "text", text: "Summary" })
  render(<SelectionToolbarInitializer />)
  await waitFor(() => expect(handlers.get("selection://action-request")).toBeDefined())

  await act(async () => {
    handlers.get("selection://candidate")?.({ payload: candidate })
  })
  expect(emitToMock).toHaveBeenCalledWith(
    "selection-toolbar",
    "selection://action-catalog",
    expect.objectContaining({
      candidateId: "candidate-1",
      actions: expect.arrayContaining([
        expect.objectContaining({ id: "plug-a:summarize", source: "plugin" }),
        expect.objectContaining({ id: "cognia:rewrite", source: "cognia" }),
      ]),
    })
  )

  await act(async () => {
    handlers.get("selection://action-request")?.({
      payload: {
        requestId: "request-1",
        candidateId: "candidate-1",
        actionId: "plug-a:summarize",
      },
    })
  })
  await waitFor(() =>
    expect(emitToMock).toHaveBeenCalledWith(
      "selection-toolbar",
      "selection://action-result",
      expect.objectContaining({
        requestId: "request-1",
        ok: true,
        result: { kind: "text", text: "Summary" },
      })
    )
  )
  await act(async () => {
    handlers.get("selection://action-request")?.({
      payload: {
        requestId: "request-1",
        candidateId: "candidate-1",
        actionId: "plug-a:summarize",
      },
    })
  })
  expect(executePluginSelectionQuickActionMock).toHaveBeenCalledTimes(1)
})

it("settles an unknown rewrite mode instead of leaving the overlay spinning", async () => {
  // `cognia:rewrite:` prefixed, so the stale guard lets it through, but the
  // suffix is not an enhance mode, so the rewrite branch skips it. Returning
  // silently here left the capsule spinning with no terminal event, and
  // `handledRequests` had already suppressed the retry.
  render(<SelectionToolbarInitializer />)
  await waitFor(() => expect(handlers.get("selection://action-request")).toBeDefined())
  emitToMock.mockClear()

  await act(async () => {
    handlers.get("selection://action-request")?.({
      payload: {
        requestId: "request-unknown-mode",
        candidateId: "candidate-1",
        actionId: "cognia:rewrite:not-a-mode",
      },
    })
  })

  await waitFor(() =>
    expect(emitToMock).toHaveBeenCalledWith(
      "selection-toolbar",
      "selection://action-result",
      expect.objectContaining({ requestId: "request-unknown-mode", ok: false, error: "stale" })
    )
  )
})

it("stages an external context and explain intent in the active session", async () => {
  useChatStore.getState().setActiveSession("session-1")
  render(<SelectionToolbarInitializer />)
  await waitFor(() => expect(stage()).toBeDefined())

  takePendingStageMock.mockResolvedValueOnce({
    candidate,
    action: { kind: "explain" },
  })
  await act(async () => {
    stage()?.({ payload: null })
  })

  expect(useChatStore.getState().contextSelections).toEqual([
    expect.objectContaining({
      kind: "external",
      candidateId: "candidate-1",
      sourceApp: "TextEdit",
      sourceTitle: "Draft",
      snapshot: "selected text",
    }),
  ])
  expect(useComposerIntentStore.getState().pendingBySession["session-1"]).toEqual({
    candidateId: "candidate-1",
    prompt: "prompts.explain",
  })
  expect(pushMock).toHaveBeenCalledWith("/")
})

it("uses the code-specific prompt and preserves source provenance", async () => {
  useChatStore.getState().setActiveSession("session-1")
  render(<SelectionToolbarInitializer />)
  await waitFor(() => expect(stage()).toBeDefined())

  takePendingStageMock.mockResolvedValueOnce({
    candidate: {
      ...candidate,
      text: "const answer = value => value + 1;",
      sourceUrl: "https://example.com/docs/page",
      capturedAt: 1_725_000_000_000,
    },
    action: { kind: "explain" },
  })
  await act(async () => {
    stage()?.({ payload: null })
  })

  expect(useChatStore.getState().contextSelections).toEqual([
    expect.objectContaining({
      kind: "external",
      sourceUrl: "https://example.com/docs/page",
      capturedAt: 1_725_000_000_000,
    }),
  ])
  expect(useComposerIntentStore.getState().pendingBySession["session-1"]?.prompt).toBe(
    "prompts.explainCode"
  )
})

it("creates a session when needed and localizes a translation intent", async () => {
  startNewSessionMock.mockResolvedValue({ id: "session-new" })
  render(<SelectionToolbarInitializer />)
  await waitFor(() => expect(stage()).toBeDefined())

  takePendingStageMock.mockResolvedValueOnce({
    candidate,
    action: { kind: "translate", targetLocale: "zh-CN" },
  })
  await act(async () => {
    stage()?.({ payload: null })
    await Promise.resolve()
  })

  expect(startNewSessionMock).toHaveBeenCalled()
  expect(useComposerIntentStore.getState().pendingBySession["session-new"]?.prompt).toBe(
    "prompts.translate:languages.zh-CN"
  )
})

it("sharpens detected-language and measurement prompts", async () => {
  useChatStore.getState().setActiveSession("session-1")
  render(<SelectionToolbarInitializer />)
  await waitFor(() => expect(stage()).toBeDefined())

  takePendingStageMock.mockResolvedValueOnce({
    candidate: { ...candidate, id: "foreign", text: "こんにちは世界" },
    action: { kind: "translate", targetLocale: "en" },
  })
  await act(async () => {
    stage()?.({ payload: null })
  })
  expect(useComposerIntentStore.getState().pendingBySession["session-1"]?.prompt).toBe(
    "prompts.translateDetected:languages.en"
  )

  takePendingStageMock.mockResolvedValueOnce({
    candidate: { ...candidate, id: "measurement", text: "12.5 km" },
    action: { kind: "convertUnit" },
  })
  await act(async () => {
    stage()?.({ payload: null })
  })
  expect(useComposerIntentStore.getState().pendingBySession["session-1"]?.prompt).toBe(
    "prompts.convertMeasurement"
  )
})

it("deduplicates a candidate and leaves ask without a stock prompt", async () => {
  useChatStore.getState().setActiveSession("session-1")
  render(<SelectionToolbarInitializer />)
  await waitFor(() => expect(stage()).toBeDefined())

  takePendingStageMock
    .mockResolvedValueOnce({ candidate, action: { kind: "ask" } })
    .mockResolvedValueOnce({ candidate, action: { kind: "ask" } })
  await act(async () => {
    stage()?.({ payload: null })
    await Promise.resolve()
    stage()?.({ payload: null })
  })

  expect(useChatStore.getState().contextSelections).toHaveLength(1)
  expect(useComposerIntentStore.getState().pendingBySession["session-1"]?.prompt).toBeNull()
})

describe("remember", () => {
  it("writes the memory and reports success back to the toolbar", async () => {
    render(<SelectionToolbarInitializer />)
    await waitFor(() => expect(stage()).toBeDefined())

    takePendingStageMock.mockResolvedValueOnce({ candidate, action: { kind: "remember" } })
    await act(async () => {
      stage()?.({ payload: null })
    })

    expect(storeExternalMemoryMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: "selected text", tags: ["selection", "TextEdit"] }),
      { channel: "selection" }
    )
    expect(emitToMock).toHaveBeenCalledWith("selection-toolbar", "selection://result", {
      candidateId: "candidate-1",
      ok: true,
      reason: undefined,
    })
    // Remembering must never yank the app forward or touch the composer.
    expect(pushMock).not.toHaveBeenCalled()
    expect(useChatStore.getState().contextSelections).toHaveLength(0)
  })

  it("forwards a PII refusal, which the gate returns rather than throws", async () => {
    storeExternalMemoryMock.mockResolvedValueOnce({ ok: false, reason: "pii_blocked" })
    render(<SelectionToolbarInitializer />)
    await waitFor(() => expect(stage()).toBeDefined())

    takePendingStageMock.mockResolvedValueOnce({ candidate, action: { kind: "remember" } })
    await act(async () => {
      stage()?.({ payload: null })
    })

    expect(emitToMock).toHaveBeenCalledWith("selection-toolbar", "selection://result", {
      candidateId: "candidate-1",
      ok: false,
      reason: "pii_blocked",
    })
  })

  it("still reports back when the write throws, so the toolbar is never stranded", async () => {
    storeExternalMemoryMock.mockRejectedValueOnce(new Error("dexie is closed"))
    render(<SelectionToolbarInitializer />)
    await waitFor(() => expect(stage()).toBeDefined())

    takePendingStageMock.mockResolvedValueOnce({ candidate, action: { kind: "remember" } })
    await act(async () => {
      stage()?.({ payload: null })
    })

    expect(emitToMock).toHaveBeenCalledWith("selection-toolbar", "selection://result", {
      candidateId: "candidate-1",
      ok: false,
      reason: undefined,
    })
  })
})

describe("speak", () => {
  it("plays here and streams playback state to the toolbar", async () => {
    render(<SelectionToolbarInitializer />)
    await waitFor(() => expect(stage()).toBeDefined())

    takePendingStageMock.mockResolvedValueOnce({ candidate, action: { kind: "speak" } })
    await act(async () => {
      stage()?.({ payload: null })
    })

    expect(speakSelectionMock).toHaveBeenCalledWith({
      candidateId: "candidate-1",
      text: "selected text",
    })
    expect(pushMock).not.toHaveBeenCalled()

    await act(async () => {
      speechSubscriber?.({ playing: true, progress: 0.5 })
    })
    expect(emitToMock).toHaveBeenCalledWith("selection-toolbar", "selection://speech", {
      candidateId: "candidate-1",
      playing: true,
      progress: 0.5,
    })
  })

  it("drops the subscription once playback ends", async () => {
    render(<SelectionToolbarInitializer />)
    await waitFor(() => expect(stage()).toBeDefined())

    takePendingStageMock.mockResolvedValueOnce({ candidate, action: { kind: "speak" } })
    await act(async () => {
      stage()?.({ payload: null })
    })
    await act(async () => {
      speechSubscriber?.({ playing: false })
    })
    expect(unwatchMock).toHaveBeenCalled()
  })

  it("reports completion when synthesis fails, instead of leaving a spinner up forever", async () => {
    speakSelectionMock.mockRejectedValueOnce(new Error("no provider key"))
    render(<SelectionToolbarInitializer />)
    await waitFor(() => expect(stage()).toBeDefined())

    takePendingStageMock.mockResolvedValueOnce({ candidate, action: { kind: "speak" } })
    await act(async () => {
      stage()?.({ payload: null })
    })

    await waitFor(() =>
      expect(emitToMock).toHaveBeenCalledWith("selection-toolbar", "selection://speech", {
        candidateId: "candidate-1",
        playing: false,
      })
    )
  })

  it("stops only the candidate the toolbar asked about", async () => {
    render(<SelectionToolbarInitializer />)
    await waitFor(() => expect(handlers.get("selection://speech-stop")).toBeDefined())

    await act(async () => {
      handlers.get("selection://speech-stop")?.({ payload: { candidateId: "candidate-1" } })
    })
    expect(stopSelectionSpeechMock).toHaveBeenCalledWith("candidate-1")
  })
})

it("disposes listeners that resolve after unmount, and drains no stage", async () => {
  const { listen } = jest.requireMock("@tauri-apps/api/event") as {
    listen: jest.Mock
  }
  const disposers: jest.Mock[] = []
  let release: (() => void) | null = null
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  listen.mockImplementation(async (event: string, handler: (e: { payload: unknown }) => void) => {
    handlers.set(event, handler)
    await gate
    const dispose = jest.fn()
    disposers.push(dispose)
    return dispose
  })

  const { unmount } = render(<SelectionToolbarInitializer />)
  unmount()
  await act(async () => {
    release?.()
  })

  expect(disposers).toHaveLength(5)
  for (const dispose of disposers) expect(dispose).toHaveBeenCalled()
  // The boot drain must not run for a window that is already gone.
  expect(takePendingStageMock).not.toHaveBeenCalled()
})
