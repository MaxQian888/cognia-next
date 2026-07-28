/**
 * @jest-environment jsdom
 */
import { act, render, waitFor } from "@testing-library/react"

import { SelectionToolbarInitializer } from "./selection-toolbar-initializer"

let stageHandler: ((event: { payload: unknown }) => void) | null = null
const takePendingStageMock = jest.fn()
jest.mock("@tauri-apps/api/event", () => ({
  listen: jest.fn(async (_event: string, handler: (event: { payload: unknown }) => void) => {
    stageHandler = handler
    return jest.fn()
  }),
}))

jest.mock("@/lib/tauri/selection-toolbar", () => ({
  SELECTION_STAGE_EVENT: "selection://stage",
  takePendingSelectionStage: () => takePendingStageMock(),
}))

const pushMock = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}))

jest.mock("next-intl", () => ({
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
}

beforeEach(() => {
  stageHandler = null
  jest.clearAllMocks()
  takePendingStageMock.mockResolvedValue(null)
  useChatStore.getState().clear()
  useComposerIntentStore.setState({ pendingBySession: {} })
})

it("stages an external context and explain intent in the active session", async () => {
  useChatStore.getState().setActiveSession("session-1")
  render(<SelectionToolbarInitializer />)
  await waitFor(() => expect(stageHandler).not.toBeNull())

  takePendingStageMock.mockResolvedValueOnce({
    candidate,
    action: { kind: "explain" },
  })
  await act(async () => {
    stageHandler?.({ payload: null })
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

it("creates a session when needed and localizes a translation intent", async () => {
  startNewSessionMock.mockResolvedValue({ id: "session-new" })
  render(<SelectionToolbarInitializer />)
  await waitFor(() => expect(stageHandler).not.toBeNull())

  takePendingStageMock.mockResolvedValueOnce({
    candidate,
    action: { kind: "translate", targetLocale: "zh-CN" },
  })
  await act(async () => {
    stageHandler?.({ payload: null })
    await Promise.resolve()
  })

  expect(startNewSessionMock).toHaveBeenCalled()
  expect(useComposerIntentStore.getState().pendingBySession["session-new"]?.prompt).toBe(
    "prompts.translate:languages.zh-CN"
  )
})

it("deduplicates a candidate and leaves ask without a stock prompt", async () => {
  useChatStore.getState().setActiveSession("session-1")
  render(<SelectionToolbarInitializer />)
  await waitFor(() => expect(stageHandler).not.toBeNull())

  takePendingStageMock
    .mockResolvedValueOnce({ candidate, action: { kind: "ask" } })
    .mockResolvedValueOnce({ candidate, action: { kind: "ask" } })
  await act(async () => {
    stageHandler?.({ payload: null })
    await Promise.resolve()
    stageHandler?.({ payload: null })
  })

  expect(useChatStore.getState().contextSelections).toHaveLength(1)
  expect(useComposerIntentStore.getState().pendingBySession["session-1"]?.prompt).toBeNull()
})
