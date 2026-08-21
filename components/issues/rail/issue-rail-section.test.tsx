/** @jest-environment jsdom */

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

import { fireEvent, render, screen } from "@testing-library/react"
import { IssueRailSection } from "./issue-rail-section"

function renderSection(over: Partial<React.ComponentProps<typeof IssueRailSection>> = {}) {
  const props: React.ComponentProps<typeof IssueRailSection> = {
    id: "views",
    title: "Views",
    open: true,
    onOpenChange: jest.fn(),
    children: <div data-testid="body">rows</div>,
    ...over,
  }
  return { props, ...render(<IssueRailSection {...props} />) }
}

describe("IssueRailSection", () => {
  it("renders its title and body when open", () => {
    renderSection()
    expect(screen.getByText("Views")).toBeInTheDocument()
    expect(screen.getByTestId("body")).toBeInTheDocument()
  })

  it("hides the body when closed", () => {
    renderSection({ open: false })
    expect(screen.queryByTestId("body")).not.toBeInTheDocument()
  })

  it("reports the disclosure state to assistive tech", () => {
    renderSection({ open: false })
    expect(screen.getByTestId("issue-rail-toggle-views")).toHaveAttribute("aria-expanded", "false")
  })

  it("toggles on click", () => {
    const onOpenChange = jest.fn()
    renderSection({ onOpenChange })
    fireEvent.click(screen.getByTestId("issue-rail-toggle-views"))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("shows the empty text instead of the body when there is nothing to list", () => {
    renderSection({ isEmpty: true, emptyText: "No views" })
    expect(screen.getByText("No views")).toBeInTheDocument()
    expect(screen.queryByTestId("body")).not.toBeInTheDocument()
  })

  it("still renders the body when empty but no empty text was given", () => {
    renderSection({ isEmpty: true })
    expect(screen.getByTestId("body")).toBeInTheDocument()
  })

  it("renders an action as a button when it does something", () => {
    const onSelect = jest.fn()
    renderSection({
      action: { label: "Manage", icon: <span>i</span>, onSelect, testId: "act" },
    })
    fireEvent.click(screen.getByTestId("act"))
    expect(onSelect).toHaveBeenCalled()
  })

  it("renders an action as a link when it goes somewhere", () => {
    renderSection({
      action: { label: "Open", icon: <span>i</span>, href: "/projects", testId: "act" },
    })
    expect(screen.getByTestId("act")).toHaveAttribute("href", "/projects")
  })

  it("renders no action control by default", () => {
    renderSection()
    expect(screen.queryByTestId("act")).not.toBeInTheDocument()
  })
})
