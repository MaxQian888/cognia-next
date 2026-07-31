/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import { InfoIcon } from "lucide-react"
import { PluginDetailSection } from "./plugin-detail-section"

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
