/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import { MeSection } from "./me-section"

describe("<MeSection />", () => {
  it("renders the title, optional description, and children", () => {
    render(
      <MeSection title="账户" description="Manage subscription and pairing">
        <div data-testid="child-1">child 1</div>
        <div data-testid="child-2">child 2</div>
      </MeSection>
    )
    expect(screen.getByText("账户")).toBeInTheDocument()
    expect(screen.getByText("Manage subscription and pairing")).toBeInTheDocument()
    expect(screen.getByTestId("child-1")).toBeInTheDocument()
    expect(screen.getByTestId("child-2")).toBeInTheDocument()
  })

  it("aria-labels the inner ItemGroup with the section title", () => {
    render(
      <MeSection title="数据">
        <div>row</div>
      </MeSection>
    )
    const group = screen.getByRole("list", { name: "数据" })
    expect(group).toBeInTheDocument()
  })

  it("renders separators between children when withSeparators is true", () => {
    const { container } = render(
      <MeSection title="外观" withSeparators>
        <div data-testid="row-1">a</div>
        <div data-testid="row-2">b</div>
        <div data-testid="row-3">c</div>
      </MeSection>
    )
    expect(container.querySelectorAll('[data-slot="item-separator"]').length).toBe(2)
  })

  it("does not render separators when withSeparators is omitted", () => {
    const { container } = render(
      <MeSection title="外观">
        <div>a</div>
        <div>b</div>
      </MeSection>
    )
    expect(container.querySelector('[data-slot="item-separator"]')).toBeNull()
  })

  it("filters out falsy children before computing separator positions", () => {
    const { container } = render(
      <MeSection title="混合" withSeparators>
        <div>a</div>
        {false}
        {null}
        <div>b</div>
      </MeSection>
    )
    expect(container.querySelectorAll('[data-slot="item-separator"]').length).toBe(1)
  })

  it("renders an action beside the heading rather than inside the group", () => {
    // A section-level control used to have to live inside the row group as a
    // full-width button. /me/storage stacked two of those, both reading
    // "Refresh", in the middle of the reading flow.
    const { container } = render(
      <MeSection title="Storage" action={<button data-testid="sec-action">Refresh</button>}>
        <div>row</div>
      </MeSection>
    )
    const action = screen.getByTestId("sec-action")
    expect(action).toBeInTheDocument()
    const group = container.querySelector('[data-slot="item-group"]')
    expect(group).not.toBeNull()
    expect(group?.contains(action)).toBe(false)
  })

  it("renders no action wrapper when none is supplied", () => {
    const { container } = render(
      <MeSection title="Storage">
        <div>row</div>
      </MeSection>
    )
    const header = container.querySelector("section > div")
    expect(header?.children).toHaveLength(1)
  })

  it("skips the surface when every row is conditional and none rendered", () => {
    // Auto backup on /me/backup has one row, an interval field that only
    // exists while the toggle is on. With the surface unconditional, the
    // section painted an empty bordered box two pixels tall under its heading.
    const { container } = render(
      <MeSection title="Auto backup">{false}</MeSection>
    )
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Auto backup")
    expect(container.querySelector('[data-slot="item-group"]')).toBeNull()
  })

  it("attaches the supplied testid to the section element", () => {
    render(
      <MeSection title="测试" testid="me-section-account">
        <div>row</div>
      </MeSection>
    )
    expect(screen.getByTestId("me-section-account")).toBeInTheDocument()
  })
})
