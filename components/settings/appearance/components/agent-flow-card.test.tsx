/**
 * @jest-environment jsdom
 */

import * as ReactForMock from "react"
import { fireEvent, render } from "@testing-library/react"

import { AgentFlowCard } from "./agent-flow-card"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Render shadcn Select as a native <select> so we can drive value changes.
jest.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string
    onValueChange: (v: string) => void
    children: React.ReactNode
  }) =>
    ReactForMock.createElement(
      "select",
      {
        "data-testid": "agent-flow-mode-select",
        value,
        onChange: (e: { target: { value: string } }) => onValueChange(e.target.value),
      },
      children
    ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => children,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) =>
    ReactForMock.createElement("option", { value }, children),
}))

const setMode = jest.fn()
let currentMode = "standard"
jest.mock("@/hooks/chat/use-agent-flow-mode", () => ({
  useAgentFlowMode: () => ({ mode: currentMode, setMode }),
}))

beforeEach(() => {
  setMode.mockClear()
  currentMode = "standard"
})

describe("AgentFlowCard", () => {
  it("renders the three modes and reflects the current value", () => {
    const { getByTestId } = render(<AgentFlowCard />)
    const select = getByTestId("agent-flow-mode-select") as HTMLSelectElement
    expect(select.value).toBe("standard")
    expect(select.querySelectorAll("option")).toHaveLength(3)
  })

  it("persists a new mode via setMode", () => {
    const { getByTestId } = render(<AgentFlowCard />)
    fireEvent.change(getByTestId("agent-flow-mode-select"), { target: { value: "detailed" } })
    expect(setMode).toHaveBeenCalledWith("detailed")
  })

  it("shows the per-mode hint", () => {
    currentMode = "simplified"
    const { container } = render(<AgentFlowCard />)
    expect(container.textContent).toContain("hint.simplified")
  })
})
