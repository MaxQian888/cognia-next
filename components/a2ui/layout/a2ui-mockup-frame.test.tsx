/**
 * Tests for A2UIMockupFrame layout primitive.
 */

import React from "react"
import { render, screen } from "@testing-library/react"
import { A2UIMockupFrame } from "./a2ui-mockup-frame"
import type { A2UIComponentProps, A2UIMockupFrameComponent } from "@/types/a2ui/schema"

function makeProps(
  overrides: Partial<A2UIMockupFrameComponent> = {}
): A2UIComponentProps<A2UIMockupFrameComponent> {
  const component: A2UIMockupFrameComponent = {
    id: "mock-1",
    component: "MockupFrame",
    title: overrides.title,
    caption: overrides.caption,
    frameStyle: overrides.frameStyle,
    children: overrides.children ?? [],
  }
  return {
    component,
    surfaceId: "surface-1",
    dataModel: {},
    onAction: jest.fn(),
    onDataChange: jest.fn(),
    renderChild: jest.fn((id: string) => <div data-testid={`child-${id}`}>{id}</div>),
  }
}

describe("A2UIMockupFrame", () => {
  it("renders title and caption when provided", () => {
    render(
      <A2UIMockupFrame
        {...makeProps({ title: "Inbox Mockup", caption: "Review layout", children: [] })}
      />
    )
    expect(screen.getByText("Inbox Mockup")).toBeInTheDocument()
    expect(screen.getByText("Review layout")).toBeInTheDocument()
  })

  it("renders nested children via renderChild", () => {
    const props = makeProps({ children: ["hero", "footer"] })
    render(<A2UIMockupFrame {...props} />)
    expect(screen.getByTestId("child-hero")).toBeInTheDocument()
    expect(screen.getByTestId("child-footer")).toBeInTheDocument()
    expect(props.renderChild).toHaveBeenCalledWith("hero")
    expect(props.renderChild).toHaveBeenCalledWith("footer")
  })

  it("renders the browser chrome dots for the default frameStyle", () => {
    const { container } = render(<A2UIMockupFrame {...makeProps({ children: [] })} />)
    // 3 colored dots (rose / amber / emerald) live in the chrome strip
    expect(container.querySelectorAll(".bg-rose-400")).toHaveLength(1)
    expect(container.querySelectorAll(".bg-amber-400")).toHaveLength(1)
    expect(container.querySelectorAll(".bg-emerald-400")).toHaveLength(1)
  })

  it("renders the notch bar for the mobile frameStyle (no browser dots)", () => {
    const { container } = render(
      <A2UIMockupFrame {...makeProps({ frameStyle: "mobile", children: [] })} />
    )
    expect(container.querySelectorAll(".bg-rose-400")).toHaveLength(0)
    expect(container.querySelector(".rounded-full.bg-foreground\\/10")).not.toBeNull()
  })

  it("renders the desktop frameStyle without chrome and without notch", () => {
    const { container } = render(
      <A2UIMockupFrame {...makeProps({ frameStyle: "desktop", children: [] })} />
    )
    expect(container.querySelectorAll(".bg-rose-400")).toHaveLength(0)
    expect(container.querySelector(".rounded-full.bg-foreground\\/10")).toBeNull()
  })

  it("renders nothing in the header when neither title nor caption is set", () => {
    render(<A2UIMockupFrame {...makeProps({ children: [] })} />)
    expect(screen.queryByRole("heading")).toBeNull()
  })
})
