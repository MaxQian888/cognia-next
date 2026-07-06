import { render, screen, fireEvent } from "@testing-library/react"
import { TooltipProvider } from "@/components/ui/tooltip"

// Stub Radix DropdownMenu to render inline so menu items are queryable without
// driving the open interaction (repo convention; see scheduler tests).
jest.mock("@/components/ui/dropdown-menu")

import { EditorToolbar } from "./toolbar"

function renderToolbar(props: Partial<React.ComponentProps<typeof EditorToolbar>> = {}) {
  return render(
    <TooltipProvider>
      <EditorToolbar
        workflowName="Flow"
        onRename={() => {}}
        dirty={false}
        onSave={() => {}}
        {...props}
      />
    </TooltipProvider>
  )
}

describe("EditorToolbar share-image item", () => {
  it("invokes onShareImage from the overflow menu", () => {
    const onShareImage = jest.fn()
    renderToolbar({ onShareImage, onExportImage: () => {} })
    fireEvent.click(screen.getByTestId("workflow-share-image"))
    expect(onShareImage).toHaveBeenCalledTimes(1)
  })

  it("omits the share item when onShareImage is not provided", () => {
    renderToolbar({ onExportImage: () => {} })
    expect(screen.queryByTestId("workflow-share-image")).not.toBeInTheDocument()
  })
})

describe("EditorToolbar panel toggles", () => {
  it("invokes onToggleLeftPanel / onToggleRightPanel and reflects collapsed state via aria-pressed", () => {
    const onToggleLeftPanel = jest.fn()
    const onToggleRightPanel = jest.fn()
    renderToolbar({
      onToggleLeftPanel,
      leftPanelCollapsed: true,
      onToggleRightPanel,
      rightPanelCollapsed: false,
    })
    const left = screen.getByTestId("workflow-toggle-left-panel")
    const right = screen.getByTestId("workflow-toggle-right-panel")
    expect(left).toHaveAttribute("aria-pressed", "false")
    expect(right).toHaveAttribute("aria-pressed", "true")
    fireEvent.click(left)
    fireEvent.click(right)
    expect(onToggleLeftPanel).toHaveBeenCalledTimes(1)
    expect(onToggleRightPanel).toHaveBeenCalledTimes(1)
  })

  it("omits the toggles when no handlers are provided", () => {
    renderToolbar()
    expect(screen.queryByTestId("workflow-toggle-left-panel")).not.toBeInTheDocument()
    expect(screen.queryByTestId("workflow-toggle-right-panel")).not.toBeInTheDocument()
  })
})

describe("EditorToolbar revert", () => {
  it("hides the revert item when the workflow is clean", () => {
    renderToolbar({ onRevert: () => {}, dirty: false })
    expect(screen.queryByTestId("workflow-revert")).not.toBeInTheDocument()
  })

  it("shows the revert item when dirty and confirming calls onRevert", () => {
    const onRevert = jest.fn()
    renderToolbar({ onRevert, dirty: true })
    fireEvent.click(screen.getByTestId("workflow-revert"))
    // Confirmation dialog appears; confirm fires the callback.
    fireEvent.click(screen.getByTestId("workflow-revert-confirm"))
    expect(onRevert).toHaveBeenCalledTimes(1)
  })
})
