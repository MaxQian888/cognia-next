/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import { InfoIcon } from "lucide-react"
import { PluginDetailSection, PluginDetailSectionLink } from "./plugin-detail-section"

describe("PluginDetailSection", () => {
  it("renders the title and content when open", () => {
    render(
      <PluginDetailSection icon={InfoIcon} title="Capabilities" open onOpenChange={() => {}}>
        <div>body</div>
      </PluginDetailSection>
    )
    expect(screen.getByText("Capabilities")).toBeInTheDocument()
    expect(screen.getByText("body")).toBeInTheDocument()
  })

  it("reflects the open state on the trigger", () => {
    render(
      <PluginDetailSection
        icon={InfoIcon}
        title="Data"
        open={false}
        onOpenChange={() => {}}
        testId="section-data"
      >
        <div>body</div>
      </PluginDetailSection>
    )
    expect(screen.getByTestId("section-data")).toHaveAttribute("data-state", "closed")
  })

  it("calls onOpenChange when the trigger is clicked", () => {
    const onOpenChange = jest.fn()
    render(
      <PluginDetailSection
        icon={InfoIcon}
        title="Permissions"
        open={false}
        onOpenChange={onOpenChange}
        testId="section-perms"
      >
        <div>body</div>
      </PluginDetailSection>
    )
    fireEvent.click(screen.getByTestId("section-perms"))
    expect(onOpenChange).toHaveBeenCalledWith(true)
  })
})

describe("PluginDetailSectionLink", () => {
  it("navigates instead of expanding", () => {
    render(
      <PluginDetailSectionLink
        icon={InfoIcon}
        title="Logs"
        href="/logs?src=plugin&q=alpha"
        testId="section-logs"
      />
    )
    const link = screen.getByTestId("section-logs")
    expect(link.tagName).toBe("A")
    expect(link).toHaveAttribute("href", "/logs?src=plugin&q=alpha")
    // No disclosure state, because there is nothing here to disclose.
    expect(link).not.toHaveAttribute("data-state")
  })

  it("renders the destination hint under the title when given one", () => {
    render(
      <PluginDetailSectionLink
        icon={InfoIcon}
        title="Logs"
        description="Open in the log panel"
        href="/logs"
      />
    )
    expect(screen.getByText("Logs")).toBeInTheDocument()
    expect(screen.getByText("Open in the log panel")).toBeInTheDocument()
  })

  it("omits the hint line when there is no description", () => {
    render(<PluginDetailSectionLink icon={InfoIcon} title="Logs" href="/logs" testId="link" />)
    expect(screen.getByTestId("link").querySelectorAll("span")).toHaveLength(2)
  })
})
