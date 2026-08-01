/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

import { DockTab } from "./dock-tab"
import type { DockPanelInstance } from "@/types/dock/instance"

function instance(overrides: Partial<DockPanelInstance> = {}): DockPanelInstance {
  return {
    instanceId: "i1",
    panelId: "review",
    kind: "panel",
    mode: "pinned",
    dirty: false,
    activated: true,
    ...overrides,
  }
}

function renderTab(overrides: Partial<DockPanelInstance> = {}, active = true) {
  const onPin = jest.fn()
  const onSelect = jest.fn()
  const onRequestClose = jest.fn()
  render(
    <DockTab
      instance={instance(overrides)}
      title="Review"
      active={active}
      onPin={onPin}
      onSelect={onSelect}
      onRequestClose={onRequestClose}
    />
  )
  return { onPin, onSelect, onRequestClose }
}

describe("DockTab", () => {
  it("selects on click and pins on double-click", () => {
    const { onPin, onSelect } = renderTab({ mode: "preview" })
    const tab = screen.getByRole("tab", { name: "Review" })
    fireEvent.click(tab)
    expect(onSelect).toHaveBeenCalledWith("i1")
    fireEvent.doubleClick(tab)
    expect(onPin).toHaveBeenCalledWith("i1")
  })

  it("marks the preview slot italic and titles it as such", () => {
    renderTab({ mode: "preview" })
    const tab = screen.getByRole("tab", { name: "Review" })
    expect(tab).toHaveClass("italic")
    expect(tab).toHaveAttribute("title", expect.stringContaining("preview"))
    expect(screen.getByTestId("dock-tab-i1")).toHaveAttribute("data-preview", "true")
  })

  it("shows a plain title and no preview marker for a pinned tab", () => {
    renderTab()
    const tab = screen.getByRole("tab", { name: "Review" })
    expect(tab).not.toHaveClass("italic")
    expect(tab).toHaveAttribute("title", "Review")
    expect(screen.getByTestId("dock-tab-i1")).not.toHaveAttribute("data-preview")
  })

  it("routes a close through the caller so a dirty guard can intercept it", () => {
    // dockview removes panels synchronously with no cancellable hook, so the
    // confirmation has to happen before the removal is even requested.
    const { onRequestClose, onSelect } = renderTab()
    fireEvent.click(screen.getByTestId("dock-tab-close-i1"))
    expect(onRequestClose).toHaveBeenCalledWith("i1")
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("replaces the close icon with a dirty marker and relabels it", () => {
    renderTab({ dirty: true })
    const close = screen.getByTestId("dock-tab-close-i1")
    expect(close).toHaveAttribute("aria-label", expect.stringContaining("dirty"))
    expect(screen.getByTestId("dock-tab-i1")).toHaveAttribute("data-dirty", "true")
  })

  it("shows an unread badge and caps it", () => {
    const { unmount } = render(
      <DockTab
        instance={instance({ unread: 3 })}
        title="Review"
        active
        onPin={jest.fn()}
        onSelect={jest.fn()}
        onRequestClose={jest.fn()}
      />
    )
    expect(screen.getByTestId("dock-tab-unread-i1")).toHaveTextContent("3")
    unmount()

    render(
      <DockTab
        instance={instance({ unread: 42 })}
        title="Review"
        active
        onPin={jest.fn()}
        onSelect={jest.fn()}
        onRequestClose={jest.fn()}
      />
    )
    expect(screen.getByTestId("dock-tab-unread-i1")).toHaveTextContent("9+")
  })

  it("hides the badge when there is nothing unread", () => {
    renderTab()
    expect(screen.queryByTestId("dock-tab-unread-i1")).toBeNull()
  })

  it("keeps an inactive tab out of the tab order", () => {
    renderTab({}, false)
    const tab = screen.getByRole("tab", { name: "Review" })
    expect(tab).toHaveAttribute("aria-selected", "false")
    expect(tab).toHaveAttribute("tabindex", "-1")
  })
})
