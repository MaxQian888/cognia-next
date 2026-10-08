import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { toast } from "sonner"
import { EXTENSION_NOTICE_MS, ExternalAgentExtensionUi, stripAnsi } from "./extension-ui"
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

const ESC = String.fromCharCode(27)

it("renders terminal-styled statuses as one row of chips, colours kept and codes gone", async () => {
  render(
    <ExternalAgentExtensionUi chatSessionId="local" link={link}>
      <textarea />
    </ExternalAgentExtensionUi>
  )
  await waitFor(() => expect(mockListeners.size).toBe(1))
  emit({ kind: "status", key: "mcp", text: `${ESC}[38;2;167;152;215mMCP 0/2${ESC}[39m` }, "s1")
  emit({ kind: "status", key: "mode", text: "yolo" }, "s2")
  // A status that is only styling has nothing to say.
  emit({ kind: "status", key: "blank", text: `${ESC}[0m ` }, "s3")
  const row = screen.getByRole("status")
  const chips = screen.getAllByTestId("extension-status")
  expect(chips).toHaveLength(2)
  expect(row).toHaveTextContent("MCP 0/2")
  expect(row.textContent).not.toContain(ESC)
  expect(row.textContent).not.toContain("[38;2")
  expect(chips[0]).toHaveAttribute("title", "mcp: MCP 0/2")
  expect(screen.getByText("MCP 0/2")).toHaveStyle({ color: "rgb(167, 152, 215)" })
})

it("draws widgets without raw escape codes", async () => {
  render(
    <ExternalAgentExtensionUi chatSessionId="local" link={link}>
      <textarea />
    </ExternalAgentExtensionUi>
  )
  await waitFor(() => expect(mockListeners.size).toBe(1))
  emit({
    kind: "widget",
    key: "bg",
    lines: [`${ESC}[48;2;183;223;255m bg v2.6.9 ${ESC}[0m`],
    placement: "belowEditor",
  })
  const widget = screen.getByTestId("extension-widget")
  expect(widget).toHaveTextContent("bg v2.6.9")
  expect(widget.textContent).not.toContain(ESC)
})

it("shows info notices on the strip for a moment instead of toasting them", async () => {
  jest.useFakeTimers()
  try {
    render(
      <ExternalAgentExtensionUi chatSessionId="local" link={link}>
        <textarea />
      </ExternalAgentExtensionUi>
    )
    await waitFor(() => expect(mockListeners.size).toBe(1))
    emit({ kind: "notification", level: "info", message: "RTK rewrite: ls -> rtk ls" }, "n1")
    expect(toast.info).not.toHaveBeenCalled()
    expect(screen.getByTestId("extension-notice")).toHaveTextContent("RTK rewrite: ls -> rtk ls")
    // The next one replaces it rather than stacking.
    emit({ kind: "notification", level: "info", message: "RTK rewrite: cat -> rtk read" }, "n2")
    expect(screen.getAllByTestId("extension-notice")).toHaveLength(1)
    expect(screen.getByTestId("extension-notice")).toHaveTextContent("cat -> rtk read")
    act(() => jest.advanceTimersByTime(EXTENSION_NOTICE_MS))
    expect(screen.queryByTestId("extension-notice")).not.toBeInTheDocument()
  } finally {
    jest.useRealTimers()
  }
})

it("lets the user dismiss an info notice", async () => {
  render(
    <ExternalAgentExtensionUi chatSessionId="local" link={link}>
      <textarea />
    </ExternalAgentExtensionUi>
  )
  await waitFor(() => expect(mockListeners.size).toBe(1))
  emit({ kind: "notification", level: "info", message: "hello" }, "n1")
  fireEvent.click(screen.getByRole("button", { name: "Dismiss notice" }))
  expect(screen.queryByTestId("extension-notice")).not.toBeInTheDocument()
})

it("toasts a repeated warning once per conversation and agent, and every error", async () => {
  render(
    <ExternalAgentExtensionUi chatSessionId="local" link={link}>
      <textarea />
    </ExternalAgentExtensionUi>
  )
  await waitFor(() => expect(mockListeners.size).toBe(1))
  const warning = "pi-permission-system: project is not trusted"
  emit({ kind: "notification", level: "warning", message: warning }, "w1")
  emit({ kind: "notification", level: "warning", message: warning }, "w2")
  expect(toast.warning).toHaveBeenCalledTimes(1)
  emit({ kind: "notification", level: "error", message: `${ESC}[31mboom${ESC}[0m` }, "e1")
  emit({ kind: "notification", level: "error", message: `${ESC}[31mboom${ESC}[0m` }, "e2")
  expect(toast.error).toHaveBeenCalledTimes(2)
  expect(toast.error).toHaveBeenLastCalledWith("boom", expect.anything())
})

it("strips terminal styling", () => {
  expect(stripAnsi(`${ESC}[1;32mok${ESC}[0m ${ESC}[2K`)).toBe("ok ")
})
