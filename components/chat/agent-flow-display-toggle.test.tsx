/**
 * @jest-environment jsdom
 */

import { fireEvent, render } from "@testing-library/react"

import { AgentFlowDisplayToggle } from "./agent-flow-display-toggle"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
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

describe("AgentFlowDisplayToggle", () => {
  it("renders the three mode items", () => {
    const { getByTestId } = render(<AgentFlowDisplayToggle />)
    expect(getByTestId("agent-flow-simplified")).toBeTruthy()
    expect(getByTestId("agent-flow-standard")).toBeTruthy()
    expect(getByTestId("agent-flow-detailed")).toBeTruthy()
  })

  it("calls setMode when a different mode is selected", () => {
    const { getByTestId } = render(<AgentFlowDisplayToggle />)
    fireEvent.click(getByTestId("agent-flow-simplified"))
    expect(setMode).toHaveBeenCalledWith("simplified")
  })

  it("ignores deselecting the active item (empty value)", () => {
    currentMode = "standard"
    const { getByTestId } = render(<AgentFlowDisplayToggle />)
    // Clicking the already-active item deselects → onValueChange("") → guarded.
    fireEvent.click(getByTestId("agent-flow-standard"))
    expect(setMode).not.toHaveBeenCalled()
  })
})
