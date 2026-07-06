/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, act, within } from "@testing-library/react"
import { useChatStore } from "@/stores/chat"
import { WorkflowRefChips } from "./workflow-ref-chips"

// Echo translation keys so we don't need an intl provider.
jest.mock("next-intl", () => ({
  useTranslations: (ns?: string) => (key: string) => `${ns}.${key}`,
}))

beforeEach(() => {
  act(() => useChatStore.getState().clearReferencedWorkflowElements())
})

describe("WorkflowRefChips", () => {
  it("renders nothing when there are no references", () => {
    const { container } = render(<WorkflowRefChips />)
    expect(container).toBeEmptyDOMElement()
  })

  it("renders a chip per staged element with its label + kind", () => {
    act(() => {
      useChatStore.getState().addReferencedWorkflowElement({
        type: "node",
        id: "n_a",
        label: "Draft",
        kind: "ai.prompt",
      })
      useChatStore.getState().addReferencedWorkflowElement({
        type: "edge",
        id: "e_1",
        label: "A → B",
        kind: "default",
      })
    })
    render(<WorkflowRefChips />)
    const nodeChip = screen.getByTestId("workflow-ref-chip-n_a")
    expect(nodeChip).toHaveTextContent("Draft")
    expect(nodeChip).toHaveTextContent("ai.prompt")
    expect(screen.getByTestId("workflow-ref-chip-e_1")).toHaveTextContent("A → B")
  })

  it("removes a reference when its X button is clicked", () => {
    act(() => {
      useChatStore.getState().addReferencedWorkflowElement({
        type: "node",
        id: "n_a",
        label: "Draft",
        kind: "ai.prompt",
      })
    })
    render(<WorkflowRefChips />)
    fireEvent.click(within(screen.getByTestId("workflow-ref-chip-n_a")).getByRole("button"))
    expect(useChatStore.getState().referencedWorkflowElements).toHaveLength(0)
  })
})
