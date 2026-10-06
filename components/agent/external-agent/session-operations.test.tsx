/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import en from "@/i18n/messages/en.json"
import { ExternalAgentSessionOperations } from "./session-operations"

const mockManager = {
  getSessionOperationCapabilities: jest.fn(),
  getSessionRuntimeState: jest.fn(),
  enqueueSessionInput: jest.fn(),
  clearSessionInputQueue: jest.fn(),
  setSessionRuntimeControls: jest.fn(),
  setSessionQueuePolicy: jest.fn(),
  abortSessionShell: jest.fn(),
  renameSession: jest.fn(),
  archiveSession: jest.fn(),
  unarchiveSession: jest.fn(),
  exportSessionHtml: jest.fn(),
  getSessionTree: jest.fn(),
  getSessionEntries: jest.fn(),
}
jest.mock("@/lib/ai/agent/external/manager", () => ({ getExternalAgentManager: () => mockManager }))
const t = en.externalAgent.sessionOperations

function show(
  overrides: Partial<React.ComponentProps<typeof ExternalAgentSessionOperations>> = {}
) {
  const props = {
    agentId: "agent",
    sessionId: "session",
    isExecuting: true,
    onFork: jest.fn(),
    onClone: jest.fn(),
    onShell: jest.fn(),
    ...overrides,
  }
  const view = render(
    <NextIntlClientProvider locale="en" messages={en}>
      <ExternalAgentSessionOperations {...props} />
    </NextIntlClientProvider>
  )
  const details = view.container.querySelector("details")!
  details.open = true
  fireEvent(details, new Event("toggle"))
  return props
}

beforeEach(() => {
  jest.clearAllMocks()
  mockManager.getSessionOperationCapabilities.mockResolvedValue({
    inputQueue: "supported",
    clearQueue: "supported",
  })
  mockManager.enqueueSessionInput.mockResolvedValue({ disposition: "queued", mode: "follow_up" })
})

it("routes follow-up input through the common manager and clears only after acceptance", async () => {
  show()
  const input = await screen.findByRole("textbox", { name: t.queuedInput })
  fireEvent.change(input, { target: { value: "Run tests next" } })
  fireEvent.click(screen.getByRole("button", { name: t.follow_up }))
  await waitFor(() =>
    expect(mockManager.enqueueSessionInput).toHaveBeenCalledWith(
      "agent",
      "session",
      { text: "Run tests next" },
      "follow_up"
    )
  )
  await waitFor(() => expect(input).toHaveValue(""))
  expect(screen.getByRole("status")).toHaveTextContent(t.queued)
})

it("preserves input when the provider refuses it", async () => {
  mockManager.enqueueSessionInput.mockRejectedValue(new Error("Not streaming"))
  show()
  const input = await screen.findByRole("textbox", { name: t.queuedInput })
  fireEvent.change(input, { target: { value: "Keep this draft" } })
  fireEvent.click(screen.getByRole("button", { name: t.steer }))
  expect(await screen.findByRole("alert")).toHaveTextContent("Not streaming")
  expect(input).toHaveValue("Keep this draft")
})

it("restores both queues without discarding the current draft or images", async () => {
  mockManager.clearSessionInputQueue.mockResolvedValue({
    steering: [{ text: "First", images: [{ data: "aA==", mimeType: "image/png" }] }],
    followUp: [{ text: "Later" }],
  })
  show()
  const input = await screen.findByRole("textbox", { name: t.queuedInput })
  fireEvent.change(input, { target: { value: "Draft" } })
  fireEvent.click(screen.getByRole("button", { name: t.restoreQueue }))
  await waitFor(() => expect(input).toHaveValue("Draft\n\nFirst\n\nLater"))
  expect(screen.getByText("1 images attached")).toBeInTheDocument()
})

it("does not invent controls for an unsupported runtime", async () => {
  mockManager.getSessionOperationCapabilities.mockResolvedValue({
    inputQueue: "unsupported",
    backgroundTurns: "supported",
  })
  show()
  expect(await screen.findByText(t.unsupported)).toBeInTheDocument()
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
})

it("shows unreported control state rather than guessing disabled", async () => {
  mockManager.getSessionOperationCapabilities.mockResolvedValue({
    runtimeState: "supported",
    runtimeControls: "supported",
  })
  mockManager.getSessionRuntimeState.mockResolvedValue({ controls: {}, queuePolicy: {} })
  show()
  expect(await screen.findByRole("combobox", { name: t.autoRetry })).toHaveValue("")
})

it("forks the selected user entry through the shared callback", async () => {
  mockManager.getSessionOperationCapabilities.mockResolvedValue({
    tree: "supported",
    forkAtEntry: "supported",
  })
  mockManager.getSessionTree.mockResolvedValue({
    leafId: "entry",
    roots: [
      {
        entry: {
          id: "entry",
          parentId: null,
          type: "message",
          message: { role: "user", content: [{ type: "text", text: "Original request" }] },
        },
        children: [],
      },
    ],
  })
  const props = show({ isExecuting: false })
  fireEvent.click(await screen.findByRole("button", { name: t.loadTree }))
  fireEvent.click(await screen.findByRole("button", { name: t.forkHere }))
  await waitFor(() => expect(props.onFork).toHaveBeenCalledWith({ forkAtEntryId: "entry" }))
})

it("keeps shell cancellation available while execution awaits approval or output", async () => {
  mockManager.getSessionOperationCapabilities.mockResolvedValue({
    shell: "supported",
    abortShell: "supported",
  })
  mockManager.abortSessionShell.mockResolvedValue(undefined)
  let finish!: (value: {
    output: string
    exitCode: number | null
    cancelled: boolean
    truncated: boolean
  }) => void
  const onShell = jest.fn(
    () =>
      new Promise<{
        output: string
        exitCode: number | null
        cancelled: boolean
        truncated: boolean
      }>((resolve) => {
        finish = resolve
      })
  )
  show({ isExecuting: false, onShell })
  fireEvent.change(await screen.findByRole("textbox", { name: t.shell }), {
    target: { value: "pwd" },
  })
  fireEvent.click(screen.getByRole("checkbox", { name: t.excludeContext }))
  fireEvent.click(screen.getByRole("button", { name: t.runShell }))
  await waitFor(() => expect(onShell).toHaveBeenCalledWith("pwd", { excludeFromContext: true }))
  expect(screen.getByRole("button", { name: t.runShell })).toBeDisabled()
  fireEvent.click(screen.getByRole("button", { name: t.stopShell }))
  await waitFor(() =>
    expect(mockManager.abortSessionShell).toHaveBeenCalledWith("agent", "session")
  )
  finish({ output: "Cancelled output", exitCode: null, cancelled: true, truncated: false })
  expect(await screen.findByText("Cancelled output")).toBeInTheDocument()
})

it("updates only the selected queue policy through the shared manager", async () => {
  mockManager.getSessionOperationCapabilities.mockResolvedValue({ queuePolicy: "supported" })
  mockManager.setSessionQueuePolicy.mockResolvedValue(undefined)
  show()
  fireEvent.change(await screen.findByRole("combobox", { name: t.followUp }), {
    target: { value: "one-at-a-time" },
  })
  await waitFor(() =>
    expect(mockManager.setSessionQueuePolicy).toHaveBeenCalledWith("agent", "session", {
      followUp: "one-at-a-time",
    })
  )
})

it("renames and exports the native session without selecting an arbitrary export destination", async () => {
  mockManager.getSessionOperationCapabilities.mockResolvedValue({
    rename: "supported",
    exportHtml: "supported",
  })
  mockManager.renameSession.mockResolvedValue(undefined)
  mockManager.exportSessionHtml.mockResolvedValue({ path: "/workspace/session.html" })
  show({ isExecuting: false })
  fireEvent.change(await screen.findByRole("textbox", { name: t.sessionName }), {
    target: { value: "  Reviewed session  " },
  })
  fireEvent.click(screen.getByRole("button", { name: t.rename }))
  await waitFor(() =>
    expect(mockManager.renameSession).toHaveBeenCalledWith("agent", "session", "Reviewed session")
  )
  await waitFor(() => expect(screen.getByRole("button", { name: t.exportHtml })).not.toBeDisabled())
  fireEvent.click(screen.getByRole("button", { name: t.exportHtml }))
  await waitFor(() =>
    expect(mockManager.exportSessionHtml).toHaveBeenCalledWith("agent", "session")
  )
  expect(await screen.findByRole("status")).toHaveTextContent("/workspace/session.html")
})

it("shows an empty entry result after loading", async () => {
  mockManager.getSessionOperationCapabilities.mockResolvedValue({ entries: "supported" })
  mockManager.getSessionEntries.mockResolvedValue([])
  show({ isExecuting: false })
  expect(screen.queryByText("[]")).not.toBeInTheDocument()
  fireEvent.click(await screen.findByRole("button", { name: t.loadEntries }))
  expect(await screen.findByText("[]", { selector: "pre" })).toBeInTheDocument()
})

it("preserves non-message metadata in the entry inspector", async () => {
  mockManager.getSessionOperationCapabilities.mockResolvedValue({ entries: "supported" })
  const entries = [
    {
      id: "custom-1",
      parentId: null,
      type: "custom",
      metadata: { customType: "checkpoint", data: { branch: "experiment" } },
    },
  ]
  mockManager.getSessionEntries.mockResolvedValue(entries)
  show({ isExecuting: false })
  fireEvent.click(await screen.findByRole("button", { name: t.loadEntries }))
  expect(
    await screen.findByText(
      (_, element) =>
        element?.tagName === "PRE" && element.textContent === JSON.stringify(entries, null, 2)
    )
  ).toBeInTheDocument()
})

it("preserves provider-declared turn fork boundaries and archive lifecycle", async () => {
  mockManager.getSessionOperationCapabilities.mockResolvedValue({
    entries: "supported",
    forkAtEntry: "supported",
    archive: "supported",
    unarchive: "supported",
  })
  mockManager.getSessionEntries.mockResolvedValue([
    {
      id: "turn-1",
      parentId: null,
      type: "turn",
      forkAt: { kind: "turn", id: "turn-1", boundary: "before" },
    },
  ])
  const props = show({ isExecuting: false })
  fireEvent.click(await screen.findByRole("button", { name: t.loadEntries }))
  fireEvent.click(await screen.findByRole("button", { name: t.forkHere }))
  await waitFor(() =>
    expect(props.onFork).toHaveBeenCalledWith({
      forkAt: { kind: "turn", id: "turn-1", boundary: "before" },
    })
  )
  fireEvent.click(screen.getByRole("button", { name: t.archive }))
  await waitFor(() => expect(mockManager.archiveSession).toHaveBeenCalledWith("agent", "session"))
  fireEvent.click(screen.getByRole("button", { name: t.unarchive }))
  await waitFor(() => expect(mockManager.unarchiveSession).toHaveBeenCalledWith("agent", "session"))
})
