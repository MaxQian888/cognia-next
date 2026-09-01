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

const useAgentRuntimeMock = jest.fn()

jest.mock("@/stores/agent/agent-runtime-store", () => ({
  useRuntimeRefForSession: () =>
    (useAgentRuntimeMock() as { runtime?: string })?.runtime === "external"
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
  beforeEach(() => {
    jest.clearAllMocks()
    useAgentRuntimeMock.mockReset()
    useExternalAgentMock.mockReset()
    hasPluginToolbarMock.mockReturnValue(false)
  })

  it("renders nothing when runtime is claude-sdk", () => {
    useAgentRuntimeMock.mockReturnValue({ runtime: "claude-sdk" })
    useExternalAgentMock.mockReturnValue(baseAgentState)
    const { container } = render(wrap(<ExternalAgentSessionPanel />))
    expect(container.firstChild).toBeNull()
  })

  it("renders nothing when runtime is external but no session data is present", () => {
    useAgentRuntimeMock.mockReturnValue({ runtime: "external" })
    useExternalAgentMock.mockReturnValue(baseAgentState)
    const { container } = render(wrap(<ExternalAgentSessionPanel />))
    expect(container.firstChild).toBeNull()
  })

  it("renders the commands button when commands are available", () => {
    useAgentRuntimeMock.mockReturnValue({ runtime: "external" })
    useExternalAgentMock.mockReturnValue({
      ...baseAgentState,
      availableCommands: [{ name: "test", description: "run tests", input: null }],
    })
    render(wrap(<ExternalAgentSessionPanel />))
    expect(screen.getByText(en.externalAgent.commands)).toBeInTheDocument()
  })

  it("still renders (with the plugin slot) when a plugin contributes a toolbar control and there is no native session data", () => {
    hasPluginToolbarMock.mockReturnValue(true)
    useAgentRuntimeMock.mockReturnValue({ runtime: "external" })
    useExternalAgentMock.mockReturnValue(baseAgentState)
    render(wrap(<ExternalAgentSessionPanel />))
    const slot = screen.getByTestId("slot-agent.external-session.toolbar")
    const ctx = JSON.parse(slot.getAttribute("data-context") ?? "{}")
    expect(ctx).toMatchObject({ isExecuting: false, hasPlan: false, hasCommands: false })
  })

  it("shows the compact button only when the adapter supports compaction and triggers it", async () => {
    const compactSession = jest.fn(async () => {})
    useAgentRuntimeMock.mockReturnValue({ runtime: "external" })
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
    useAgentRuntimeMock.mockReturnValue({ runtime: "external" })
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
    useAgentRuntimeMock.mockReturnValue({ runtime: "external" })
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
    useAgentRuntimeMock.mockReturnValue({ runtime: "external" })
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
    useAgentRuntimeMock.mockReturnValue({ runtime: "external" })
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
    useAgentRuntimeMock.mockReturnValue({ runtime: "external" })
    useExternalAgentMock.mockReturnValue({
      ...baseAgentState,
      activeSession: { id: "thr_1" },
      forkSession: jest.fn(),
    })
    render(wrap(<ExternalAgentSessionPanel />))
    expect(screen.queryByTestId("provider-undo-button")).not.toBeInTheDocument()
  })

  it("renders the execution plan when entries are available", () => {
    useAgentRuntimeMock.mockReturnValue({ runtime: "external" })
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
