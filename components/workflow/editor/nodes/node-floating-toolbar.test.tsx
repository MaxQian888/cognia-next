/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { NodeFloatingToolbar } from "./node-floating-toolbar"

function renderToolbar(overrides: Partial<React.ComponentProps<typeof NodeFloatingToolbar>> = {}) {
  const onRun = jest.fn()
  const onCopy = jest.fn()
  const onConfigure = jest.fn()
  const onDelete = jest.fn()
  const onMore = jest.fn()
  const utils = render(
    <TooltipProvider>
      <NodeFloatingToolbar
        nodeId="n_a"
        kind="ai.prompt"
        alwaysVisible={true}
        motionEnabled={true}
        onRun={overrides.onRun ?? onRun}
        onCopy={overrides.onCopy ?? onCopy}
        onConfigure={overrides.onConfigure ?? onConfigure}
        onDelete={overrides.onDelete ?? onDelete}
        onMore={overrides.onMore ?? onMore}
        {...overrides}
      />
    </TooltipProvider>
  )
  return { ...utils, onRun, onCopy, onConfigure, onDelete, onMore }
}

describe("NodeFloatingToolbar", () => {
  it("renders five action buttons in the documented order", () => {
    renderToolbar()
    const buttons = screen.getAllByRole("button")
    expect(buttons).toHaveLength(5)
    expect(buttons[0].getAttribute("data-testid")).toBe("wf-node-toolbar-run")
    expect(buttons[1].getAttribute("data-testid")).toBe("wf-node-toolbar-copy")
    expect(buttons[2].getAttribute("data-testid")).toBe("wf-node-toolbar-configure")
    expect(buttons[3].getAttribute("data-testid")).toBe("wf-node-toolbar-delete")
    expect(buttons[4].getAttribute("data-testid")).toBe("wf-node-toolbar-more")
  })

  it("fires callbacks for each action", () => {
    const { onRun, onCopy, onConfigure, onDelete } = renderToolbar()
    fireEvent.click(screen.getByTestId("wf-node-toolbar-run"))
    fireEvent.click(screen.getByTestId("wf-node-toolbar-copy"))
    fireEvent.click(screen.getByTestId("wf-node-toolbar-configure"))
    fireEvent.click(screen.getByTestId("wf-node-toolbar-delete"))
    expect(onRun).toHaveBeenCalled()
    expect(onCopy).toHaveBeenCalled()
    expect(onConfigure).toHaveBeenCalled()
    expect(onDelete).toHaveBeenCalled()
  })

  it("emits onMore with the anchor button's bounding rect", () => {
    const onMore = jest.fn()
    renderToolbar({ onMore })
    fireEvent.click(screen.getByTestId("wf-node-toolbar-more"))
    expect(onMore).toHaveBeenCalledTimes(1)
    const rectArg = onMore.mock.calls[0][0]
    expect(typeof rectArg.left).toBe("number")
    expect(typeof rectArg.top).toBe("number")
  })

  it("greys 'Run' and aria-disables for trigger kinds", () => {
    renderToolbar({ kind: "trigger.manual" })
    const runBtn = screen.getByTestId("wf-node-toolbar-run")
    expect(runBtn).toBeDisabled()
    expect(runBtn.getAttribute("aria-disabled")).toBe("true")
  })

  it("greys 'Run' for annotation kinds", () => {
    renderToolbar({ kind: "annotation.note" })
    expect(screen.getByTestId("wf-node-toolbar-run")).toBeDisabled()
  })

  it("reflects motionEnabled via the data-motion attribute", () => {
    renderToolbar({ motionEnabled: false })
    const root = screen.getByTestId("wf-node-toolbar-n_a")
    expect(root.getAttribute("data-motion")).toBe("off")
    expect(root.className).not.toContain("transition-opacity")
  })

  it("uses the transition class when motion is enabled", () => {
    renderToolbar({ motionEnabled: true })
    const root = screen.getByTestId("wf-node-toolbar-n_a")
    expect(root.className).toContain("transition-opacity")
  })

  it("toolbar is hidden unless hovered/focused when alwaysVisible=false", () => {
    renderToolbar({ alwaysVisible: false })
    const root = screen.getByTestId("wf-node-toolbar-n_a")
    expect(root.getAttribute("data-always-visible")).toBe("false")
    expect(root.className).toContain("opacity-0")
  })

  it("clicking a button does not bubble up to the parent (stopPropagation)", () => {
    const parentClick = jest.fn()
    render(
      <TooltipProvider>
        <div onClick={parentClick}>
          <NodeFloatingToolbar
            nodeId="n_a"
            kind="ai.prompt"
            alwaysVisible
            motionEnabled
            onRun={() => undefined}
            onCopy={() => undefined}
            onConfigure={() => undefined}
            onDelete={() => undefined}
            onMore={() => undefined}
          />
        </div>
      </TooltipProvider>
    )
    fireEvent.click(screen.getByTestId("wf-node-toolbar-copy"))
    expect(parentClick).not.toHaveBeenCalled()
  })
})
