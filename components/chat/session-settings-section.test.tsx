import { render, screen, fireEvent } from "@testing-library/react"
import { BrainIcon } from "lucide-react"

import { SessionSettingsSection } from "./session-settings-section"

describe("SessionSettingsSection", () => {
  it("renders title, icon and children when open; hides the summary line", () => {
    render(
      <SessionSettingsSection
        id="memory"
        title="Memory"
        summary="Using defaults"
        icon={BrainIcon}
        open
        onOpenChange={jest.fn()}
      >
        <div data-testid="body">body</div>
      </SessionSettingsSection>
    )
    expect(screen.getByRole("button", { name: /memory/i })).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByTestId("body")).toBeInTheDocument()
    expect(screen.queryByTestId("session-settings-section-memory-summary")).not.toBeInTheDocument()
    expect(screen.queryByTestId("session-settings-section-memory-count")).not.toBeInTheDocument()
  })

  it("shows the summary and override count while collapsed, and unmounts the body", () => {
    render(
      <SessionSettingsSection
        id="memory"
        title="Memory"
        summary="2 overrides"
        overrideCount={2}
        open={false}
        onOpenChange={jest.fn()}
      >
        <div data-testid="body">body</div>
      </SessionSettingsSection>
    )
    expect(screen.getByTestId("session-settings-section-memory-summary")).toHaveTextContent(
      "2 overrides"
    )
    expect(screen.getByTestId("session-settings-section-memory-count")).toHaveTextContent("2")
    expect(screen.queryByTestId("body")).not.toBeInTheDocument()
  })

  it("reports toggles through onOpenChange", () => {
    const onOpenChange = jest.fn()
    render(
      <SessionSettingsSection id="x" title="X" open={false} onOpenChange={onOpenChange}>
        child
      </SessionSettingsSection>
    )
    fireEvent.click(screen.getByRole("button", { name: /x/i }))
    expect(onOpenChange).toHaveBeenCalledWith(true)
  })

  it("renders a static header without a toggle when not collapsible", () => {
    render(
      <SessionSettingsSection
        id="actions"
        title="Actions"
        icon={BrainIcon}
        overrideCount={1}
        open
        onOpenChange={jest.fn()}
        collapsible={false}
      >
        <div data-testid="body">body</div>
      </SessionSettingsSection>
    )
    expect(screen.queryByRole("button", { name: /actions/i })).not.toBeInTheDocument()
    expect(screen.getByText("Actions")).toBeInTheDocument()
    expect(screen.getByTestId("body")).toBeInTheDocument()
    expect(screen.getByTestId("session-settings-section-actions-count")).toHaveTextContent("1")
  })
})
