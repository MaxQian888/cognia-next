/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import en from "@/i18n/messages/en.json"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ExternalAgentSessionPanel } from "./session-panel"

const useExternalAgentMock = jest.fn()

jest.mock("@/hooks/agent/use-external-agent", () => ({
  useExternalAgent: () => useExternalAgentMock(),
}))

const useAgentRuntimeMock = jest.fn()

jest.mock("@/stores/agent", () => ({
  useAgentRuntimeStore: (selector: (s: unknown) => unknown) => selector(useAgentRuntimeMock()),
}))

const wrap = (ui: React.ReactNode) => (
  <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
    <TooltipProvider>{ui}</TooltipProvider>
  </NextIntlClientProvider>
)

const baseAgentState = {
  isExecuting: false,
  availableCommands: [],
  planEntries: [],
  planStep: null,
  configOptions: [],
  setConfigOption: jest.fn(),
  execute: jest.fn(),
}

describe("ExternalAgentSessionPanel", () => {
  beforeEach(() => {
    useAgentRuntimeMock.mockReset()
    useExternalAgentMock.mockReset()
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
