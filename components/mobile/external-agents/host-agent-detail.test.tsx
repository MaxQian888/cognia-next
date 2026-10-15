/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react"
import type { HostAgentEditorProps } from "@/components/agent/external-agent/host/host-agent-editor"
import { HostAgentDetail } from "./host-agent-detail"

const mockPush = jest.fn()
const mockReplace = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
}))

jest.mock("@/components/agent/external-agent/host/host-agent-editor", () => ({
  HostAgentEditor: ({ configId, onRemoved, onDuplicated, onOpenConfig }: HostAgentEditorProps) => (
    <div data-testid="editor" data-config-id={configId}>
      <button onClick={onRemoved}>Removed</button>
      <button onClick={() => onDuplicated("eac_copy")}>Duplicated</button>
      <button onClick={() => onOpenConfig?.("eac_sibling")}>Sibling</button>
    </div>
  ),
}))

beforeEach(() => jest.clearAllMocks())

describe("HostAgentDetail", () => {
  it("forwards the selected Host configuration", () => {
    render(<HostAgentDetail configId="eac_1" />)
    expect(screen.getByTestId("editor")).toHaveAttribute("data-config-id", "eac_1")
  })

  it("replaces the route after removal", () => {
    render(<HostAgentDetail configId="eac_1" />)
    fireEvent.click(screen.getByRole("button", { name: "Removed" }))
    expect(mockReplace).toHaveBeenCalledWith("/me/external-agents")
    expect(mockPush).not.toHaveBeenCalled()
  })

  it("pushes the new configuration after duplication", () => {
    render(<HostAgentDetail configId="eac_1" />)
    fireEvent.click(screen.getByRole("button", { name: "Duplicated" }))
    expect(mockPush).toHaveBeenCalledWith("/me/external-agents/detail?id=eac_copy")
  })

  it("pushes sibling and source configuration navigation", () => {
    render(<HostAgentDetail configId="eac_1" />)
    fireEvent.click(screen.getByRole("button", { name: "Sibling" }))
    expect(mockPush).toHaveBeenCalledWith("/me/external-agents/detail?id=eac_sibling")
  })
})
