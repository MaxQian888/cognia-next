import { act, render, screen, waitFor } from "@testing-library/react"
import { toast } from "sonner"
import { ExternalAgentExtensionUi } from "./extension-ui"
import { useComposerIntentStore } from "@/stores/chat/composer-intent-store"
import type { ExternalAgentEvent } from "@/types/agent/external-agent"

const mockListeners = new Set<(event: ExternalAgentEvent) => void>()
const mockGetSession = jest.fn()
jest.mock("@/lib/ai/agent/external/manager", () => ({
  getExternalAgentManager: () => ({
    getSession: (...args: unknown[]) => mockGetSession(...args),
    addEventListener: (_id: string, callback: (event: ExternalAgentEvent) => void) => {
      mockListeners.add(callback)
      return () => mockListeners.delete(callback)
    },
  }),
}))
jest.mock("sonner", () => ({ toast: { info: jest.fn(), warning: jest.fn(), error: jest.fn() } }))
const link = { agentId: "agent", sessionId: "native" }
const emit = (
  update: Extract<ExternalAgentEvent, { type: "extension_ui_update" }>["update"],
  id = "one",
  sessionId = "native"
) =>
  act(() => {
    for (const listener of mockListeners)
      listener({ type: "extension_ui_update", id, update, sessionId, timestamp: new Date(0) })
  })
beforeEach(() => {
  mockListeners.clear()
  mockGetSession.mockReset()
  jest.clearAllMocks()
  useComposerIntentStore.setState({ pendingBySession: {}, claimedEffects: {} })
})

it("does not subscribe for built-in conversations", async () => {
  render(
    <ExternalAgentExtensionUi chatSessionId="local">
      <textarea aria-label="input" />
    </ExternalAgentExtensionUi>
  )
  expect(mockListeners.size).toBe(0)
  expect(mockGetSession).not.toHaveBeenCalled()
})

it("renders keyed widget placement and clears status, without crossing session identities", async () => {
  render(
    <ExternalAgentExtensionUi chatSessionId="local" link={link}>
      <textarea aria-label="input" />
    </ExternalAgentExtensionUi>
  )
  await waitFor(() => expect(mockListeners.size).toBe(1))
  emit({ kind: "status", key: "ext", text: "wrong" }, "wrong", "other")
  expect(screen.queryByText("wrong")).not.toBeInTheDocument()
  emit({ kind: "widget", key: "upper", lines: ["above", "second"], placement: "aboveEditor" })
  emit({ kind: "widget", key: "lower", lines: ["below"], placement: "belowEditor" })
  const input = screen.getByRole("textbox")
  expect(
    screen.getByText(/above/).compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING
  ).toBeTruthy()
  expect(
    input.compareDocumentPosition(screen.getByText("below")) & Node.DOCUMENT_POSITION_FOLLOWING
  ).toBeTruthy()
  emit({ kind: "status", key: "ext", text: "ready" })
  expect(screen.getByRole("status")).toHaveTextContent("ready")
  emit({ kind: "status", key: "ext", text: null })
  expect(screen.queryByRole("status")).not.toBeInTheDocument()
})

it("hydrates and consumes editor replacement and severity notifications only once across remounts", async () => {
  mockGetSession.mockReturnValue({
    metadata: {
      extensionUi: {
        statuses: {},
        widgets: {},
        editor: { id: "edit", text: "" },
        notifications: [{ id: "notice", level: "warning", message: "careful" }],
      },
    },
  })
  const view = () => (
    <ExternalAgentExtensionUi chatSessionId="local" link={link}>
      <textarea />
    </ExternalAgentExtensionUi>
  )
  const first = render(view())
  await waitFor(() =>
    expect(useComposerIntentStore.getState().pendingBySession.local).toMatchObject({
      mode: "replace",
      prompt: "",
      externalSession: link,
    })
  )
  expect(toast.warning).toHaveBeenCalledTimes(1)
  first.unmount()
  useComposerIntentStore.setState({ pendingBySession: {} })
  render(view())
  await waitFor(() => expect(mockListeners.size).toBe(1))
  expect(useComposerIntentStore.getState().pendingBySession.local).toBeUndefined()
  expect(toast.warning).toHaveBeenCalledTimes(1)
})

it("restores cancelled queue text and inline images as an append intent", async () => {
  render(
    <ExternalAgentExtensionUi chatSessionId="local" link={link}>
      <textarea />
    </ExternalAgentExtensionUi>
  )
  await waitFor(() => expect(mockListeners.size).toBe(1))
  act(() => {
    for (const listener of mockListeners)
      listener({
        type: "input_queue_cleared",
        sessionId: "native",
        timestamp: new Date(0),
        queue: {
          steering: [{ text: "steered", images: [{ data: "YQ==", mimeType: "image/png" }] }],
          followUp: [{ text: "later" }],
        },
      })
  })
  expect(useComposerIntentStore.getState().pendingBySession.local).toMatchObject({
    mode: "append",
    prompt: "steered\n\nlater",
    images: [{ data: "YQ==", mimeType: "image/png" }],
    externalSession: link,
  })
})

it("replaces same-session presentation after resume without replaying consumed editor effects", async () => {
  render(
    <ExternalAgentExtensionUi chatSessionId="local" link={link}>
      <textarea />
    </ExternalAgentExtensionUi>
  )
  await waitFor(() => expect(mockListeners.size).toBe(1))
  emit({ kind: "status", key: "old", text: "old status" })
  emit({ kind: "widget", key: "old", lines: ["old widget"], placement: "aboveEditor" })
  emit({ kind: "editor", text: "first edit" }, "edit")
  useComposerIntentStore.setState({ pendingBySession: {} })
  act(() => {
    for (const listener of mockListeners)
      listener({
        type: "session_info_update",
        sessionId: "native",
        timestamp: new Date(1),
        extensionUi: {
          statuses: {},
          widgets: {},
          notifications: [],
          editor: { id: "edit", text: "first edit" },
        },
      })
  })
  expect(screen.queryByText("old status")).not.toBeInTheDocument()
  expect(screen.queryByText("old widget")).not.toBeInTheDocument()
  expect(useComposerIntentStore.getState().pendingBySession.local).toBeUndefined()
})
