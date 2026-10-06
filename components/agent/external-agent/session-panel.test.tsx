/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import en from "@/i18n/messages/en.json"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ExternalAgentSessionPanel } from "./session-panel"

jest.mock("sonner", () => ({
  toast: {
    loading: jest.fn(() => "operation-toast"),
    success: jest.fn(),
    error: jest.fn(),
  },
}))

const { toast: mockToast } = jest.requireMock("sonner") as {
  toast: {
    loading: jest.Mock
    success: jest.Mock
    error: jest.Mock
  }
}

const useExternalAgentMock = jest.fn()

jest.mock("@/hooks/agent/use-external-agent", () => ({
  useExternalAgent: () => useExternalAgentMock(),
}))

const mockAgentRuntime = jest.fn()
const mockSessionLink = jest.fn(() => undefined as unknown)
const mockSetSessionLink = jest.fn()
const mockRemoteManager = {
  getSessionOperationCapabilities: jest.fn(),
  getSessionRuntimeState: jest.fn(),
  refreshSessionCommands: jest.fn(),
  getSessionEntries: jest.fn(),
  forkSession: jest.fn(),
  archiveSession: jest.fn(),
}
jest.mock("@/lib/ai/agent/external/runtimes/remote/remote-run-client", () => ({
  createRemoteSessionOperationsClient: jest.fn(() => mockRemoteManager),
  watchRemoteSession: jest.fn(async () => ({ close: jest.fn() })),
}))

jest.mock("@/stores/agent/agent-runtime-store", () => ({
  useExternalSessionLinkForSession: () => mockSessionLink(),
  useAgentRuntimeStore: { getState: () => ({ setSessionExternalLink: mockSetSessionLink }) },
  useRuntimeRefForSession: () =>
    mockAgentRuntime()?.runtime === "host"
      ? { kind: "host" }
      : (mockAgentRuntime() as { runtime?: string })?.runtime === "external"
        ? { kind: "external", agentId: "a1" }
        : { kind: "builtin" },
}))

const hasPluginToolbarMock = jest.fn(() => false)

jest.mock("@/components/plugins/plugin-extension-slot", () => ({
  PluginExtensionSlot: ({
    point,
    context,
  }: {
    point: string
    context?: Record<string, unknown>
  }) => <div data-testid={`slot-${point}`} data-context={JSON.stringify(context)} />,
  usePluginSlotHasExtensions: () => hasPluginToolbarMock(),
}))

const wrap = (ui: React.ReactNode) => (
  <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
    <TooltipProvider>{ui}</TooltipProvider>
  </NextIntlClientProvider>
)

const baseAgentState = {
  isExecuting: false,
  isCompacting: false,
  isProviderUndoing: false,
  supportsCompaction: false,
  supportsCompactionFocus: false,
  providerUndoCapability: { status: "unsupported" },
  providerUndoAcknowledged: false,
  availableCommands: [],
  planEntries: [],
  planStep: null,
  configOptions: [],
  setConfigOption: jest.fn(),
  execute: jest.fn(),
  compactSession: jest.fn(),
  undoLastProviderChange: jest.fn(),
  acknowledgeProviderUndoWarning: jest.fn(),
}

describe("ExternalAgentSessionPanel", () => {
  it("mounts shared session controls for the active native session", () => {
    mockAgentRuntime.mockReturnValue({ runtime: "external" })
    useExternalAgentMock.mockReturnValue({
      ...baseAgentState,
      activeAgentId: "agent",
      activeSession: { id: "session" },
      forkSession: jest.fn(),
      cloneSession: jest.fn(),
      executeSessionShell: jest.fn(),
    })
    render(wrap(<ExternalAgentSessionPanel />))
    expect(screen.getByText(en.externalAgent.sessionOperations.title)).toBeInTheDocument()
  })
  beforeEach(() => {
    jest.clearAllMocks()
    mockAgentRuntime.mockReset()
    useExternalAgentMock.mockReset()
    hasPluginToolbarMock.mockReturnValue(false)
    mockSessionLink.mockReturnValue(undefined)
  })

  it("renders nothing when runtime is claude-sdk", () => {
    mockAgentRuntime.mockReturnValue({ runtime: "claude-sdk" })
    useExternalAgentMock.mockReturnValue(baseAgentState)
    const { container } = render(wrap(<ExternalAgentSessionPanel />))
    expect(container.firstChild).toBeNull()
  })

  it("renders nothing when runtime is external but no session data is present", () => {
    mockAgentRuntime.mockReturnValue({ runtime: "external" })
    useExternalAgentMock.mockReturnValue(baseAgentState)
    const { container } = render(wrap(<ExternalAgentSessionPanel />))
    expect(container.firstChild).toBeNull()
  })

  it("never shows controls for another chat's native session", () => {
    mockAgentRuntime.mockReturnValue({ runtime: "external" })
    useExternalAgentMock.mockReturnValue({
      ...baseAgentState,
      activeAgentId: "agent",
      activeSession: { id: "other-native-session" },
    })
    const { container } = render(
      wrap(
        <ExternalAgentSessionPanel
          sessionId="chat"
          externalSession={{ agentId: "agent", sessionId: "this-native-session" }}
        />
      )
    )
    expect(container).toBeEmptyDOMElement()
  })

  it("renders the commands button when commands are available", () => {
    mockAgentRuntime.mockReturnValue({ runtime: "external" })
    useExternalAgentMock.mockReturnValue({
      ...baseAgentState,
      availableCommands: [{ name: "test", description: "run tests", input: null }],
    })
    render(wrap(<ExternalAgentSessionPanel />))
    expect(screen.getByText(en.externalAgent.commands)).toBeInTheDocument()
  })

  it("routes idle commands through the owning chat send path", async () => {
    const onExecuteCommand = jest.fn(async () => {})
    mockAgentRuntime.mockReturnValue({ runtime: "external" })
    useExternalAgentMock.mockReturnValue({
      ...baseAgentState,
      availableCommands: [{ name: "review", description: "Review changes", input: null }],
    })
    render(wrap(<ExternalAgentSessionPanel onExecuteCommand={onExecuteCommand} />))
    fireEvent.click(screen.getByRole("button", { name: /Commands/ }))
    fireEvent.click(
      await screen.findByRole("button", {
        name: en.externalAgent.runCommand.replace("{name}", "review"),
      })
    )
    await waitFor(() => expect(onExecuteCommand).toHaveBeenCalledWith("/review"))
    expect(baseAgentState.execute).not.toHaveBeenCalled()
  })

  it("still renders (with the plugin slot) when a plugin contributes a toolbar control and there is no native session data", () => {
    hasPluginToolbarMock.mockReturnValue(true)
    mockAgentRuntime.mockReturnValue({ runtime: "external" })
    useExternalAgentMock.mockReturnValue(baseAgentState)
    render(wrap(<ExternalAgentSessionPanel />))
    const slot = screen.getByTestId("slot-agent.external-session.toolbar")
    const ctx = JSON.parse(slot.getAttribute("data-context") ?? "{}")
    expect(ctx).toMatchObject({ isExecuting: false, hasPlan: false, hasCommands: false })
  })

  it("shows the compact button only when the adapter supports compaction and triggers it", async () => {
    const compactSession = jest.fn(async () => {})
    mockAgentRuntime.mockReturnValue({ runtime: "external" })
    useExternalAgentMock.mockReturnValue({
      ...baseAgentState,
      activeSession: { id: "thr_1" },
      forkSession: jest.fn(),
      compactSession,
      supportsCompaction: true,
    })
    render(wrap(<ExternalAgentSessionPanel />))
    const button = screen.getByTestId("session-compact-button")
    fireEvent.click(button)
    await waitFor(() => expect(compactSession).toHaveBeenCalledWith("thr_1"))
  })

  it("hides the compact button when compaction is unsupported", () => {
    mockAgentRuntime.mockReturnValue({ runtime: "external" })
    useExternalAgentMock.mockReturnValue({
      ...baseAgentState,
      activeSession: { id: "thr_1" },
      forkSession: jest.fn(),
      compactSession: jest.fn(),
      supportsCompaction: false,
    })
    render(wrap(<ExternalAgentSessionPanel />))
    expect(screen.queryByTestId("session-compact-button")).not.toBeInTheDocument()
  })

  it("uses one standardized progress toast through compaction failure", async () => {
    const compactSession = jest.fn(async () => {
      throw new Error("provider timeout")
    })
    mockAgentRuntime.mockReturnValue({ runtime: "external" })
    useExternalAgentMock.mockReturnValue({
      ...baseAgentState,
      activeSession: { id: "thr_1" },
      forkSession: jest.fn(),
      compactSession,
      supportsCompaction: true,
    })
    render(wrap(<ExternalAgentSessionPanel />))

    fireEvent.click(screen.getByTestId("session-compact-button"))

    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith(
        en.chat.header.compactFailure.replace("{error}", "provider timeout"),
        { id: "operation-toast" }
      )
    )
    expect(mockToast.loading).toHaveBeenCalledWith(en.chat.header.compactProgress)
  })

  it("routes optional focus text only when the advertised command accepts input", async () => {
    const compactSession = jest.fn(async () => {})
    mockAgentRuntime.mockReturnValue({ runtime: "external" })
    useExternalAgentMock.mockReturnValue({
      ...baseAgentState,
      activeSession: { id: "thr_1" },
      forkSession: jest.fn(),
      compactSession,
      supportsCompaction: true,
      supportsCompactionFocus: true,
    })
    render(wrap(<ExternalAgentSessionPanel />))

    fireEvent.click(screen.getByTestId("session-compact-focus-button"))
    fireEvent.change(screen.getByLabelText(en.chat.header.compactFocusInputAria), {
      target: { value: "Preserve the deployment investigation" },
    })
    fireEvent.click(screen.getByRole("button", { name: en.chat.header.compactAria }))

    await waitFor(() =>
      expect(compactSession).toHaveBeenCalledWith("thr_1", {
        focus: "Preserve the deployment investigation",
      })
    )
  })

  it("warns once before executing provider undo", async () => {
    const acknowledgeProviderUndoWarning = jest.fn()
    const undoLastProviderChange = jest.fn(async () => {})
    mockAgentRuntime.mockReturnValue({ runtime: "external" })
    useExternalAgentMock.mockReturnValue({
      ...baseAgentState,
      activeSession: { id: "thr_1" },
      forkSession: jest.fn(),
      providerUndoCapability: { status: "supported", command: "undo" },
      acknowledgeProviderUndoWarning,
      undoLastProviderChange,
    })
    render(wrap(<ExternalAgentSessionPanel />))

    fireEvent.click(screen.getByTestId("provider-undo-button"))
    expect(screen.getByText(en.chat.header.providerUndoWarningTitle)).toBeInTheDocument()
    expect(undoLastProviderChange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: en.chat.header.providerUndoConfirm }))

    await waitFor(() => expect(undoLastProviderChange).toHaveBeenCalledWith("thr_1"))
    expect(acknowledgeProviderUndoWarning).toHaveBeenCalledTimes(1)
    expect(acknowledgeProviderUndoWarning.mock.invocationCallOrder[0]).toBeLessThan(
      undoLastProviderChange.mock.invocationCallOrder[0]
    )
  })

  it("hides provider undo when the runtime does not advertise it", () => {
    mockAgentRuntime.mockReturnValue({ runtime: "external" })
    useExternalAgentMock.mockReturnValue({
      ...baseAgentState,
      activeSession: { id: "thr_1" },
      forkSession: jest.fn(),
    })
    render(wrap(<ExternalAgentSessionPanel />))
    expect(screen.queryByTestId("provider-undo-button")).not.toBeInTheDocument()
  })

  it("renders the execution plan when entries are available", () => {
    mockAgentRuntime.mockReturnValue({ runtime: "external" })
    useExternalAgentMock.mockReturnValue({
      ...baseAgentState,
      planEntries: [
        { content: "Plan A", status: "pending", priority: "medium" },
        { content: "Plan B", status: "in_progress", priority: "high" },
      ],
      planStep: 1,
    })
    render(wrap(<ExternalAgentSessionPanel />))
    expect(screen.getByText(en.externalAgent.executionPlan)).toBeInTheDocument()
    expect(screen.getByText("Plan A")).toBeInTheDocument()
    expect(screen.getByText("Plan B")).toBeInTheDocument()
  })
})

it("uses the paired-host facade and carries the host identity when selecting a turn fork", async () => {
  const host = { configId: "remote", revision: "r1", lifecycleGeneration: 1 }
  const link = { agentId: "remote", sessionId: "native", host }
  mockAgentRuntime.mockReturnValue({ runtime: "host" })
  mockSessionLink.mockReturnValue(link)
  mockRemoteManager.getSessionOperationCapabilities.mockResolvedValue({
    entries: "supported",
    forkAtEntry: "supported",
  })
  mockRemoteManager.getSessionEntries.mockResolvedValue([
    {
      id: "t1",
      type: "turn",
      parentId: null,
      forkAt: { kind: "turn", id: "t1", boundary: "before" },
    },
  ])
  mockRemoteManager.forkSession.mockResolvedValue({ id: "branch" })
  render(wrap(<ExternalAgentSessionPanel sessionId="chat" />))
  fireEvent.click(screen.getByText(en.externalAgent.sessionOperations.title))
  fireEvent.click(
    await screen.findByRole("button", { name: en.externalAgent.sessionOperations.loadEntries })
  )
  fireEvent.click(
    await screen.findByRole("button", { name: en.externalAgent.sessionOperations.forkHere })
  )
  await waitFor(() =>
    expect(mockSetSessionLink).toHaveBeenCalledWith("chat", { ...link, sessionId: "branch" })
  )
  expect(mockRemoteManager.forkSession).toHaveBeenCalledWith("remote", "native", {
    forkAt: { kind: "turn", id: "t1", boundary: "before" },
  })
})
