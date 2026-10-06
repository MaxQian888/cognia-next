import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { AlertBlock, extractAlertFromChildren } from "./alert-block"

describe("AlertBlock", () => {
  it("titles itself with the translated alert type unless a title is given", () => {
    const { rerender } = render(<AlertBlock type="warning">body</AlertBlock>)
    expect(screen.getByText("Warning")).toBeInTheDocument()
    expect(screen.getByText("body")).toBeInTheDocument()

    rerender(
      <AlertBlock type="warning" title="Heads up">
        body
      </AlertBlock>
    )
    expect(screen.getByText("Heads up")).toBeInTheDocument()
    expect(screen.queryByText("Warning")).not.toBeInTheDocument()
  })

  it("collapses and expands when collapsible", async () => {
    const user = userEvent.setup()
    render(
      <AlertBlock type="note" collapsible>
        <span>hidden body</span>
      </AlertBlock>
    )
    const trigger = screen.getByText("Note").closest("[data-state]") as HTMLElement
    expect(trigger).toHaveAttribute("data-state", "open")
    await user.click(trigger)
    expect(trigger).toHaveAttribute("data-state", "closed")
  })
})

describe("AlertBlock tokens (ADR-0218)", () => {
  it.each([
    ["note", "info"],
    ["tip", "success"],
    ["important", "primary"],
    ["warning", "warning"],
    ["caution", "destructive"],
  ] as const)("draws %s with the %s token", (type, token) => {
    const { container } = render(<AlertBlock type={type}>body</AlertBlock>)
    const box = container.firstElementChild as HTMLElement
    expect(box.className).toContain(`border-${token}/`)
    expect(box.className).not.toMatch(/(blue|green|purple|yellow|red)-500/)
    expect(box).toHaveClass("my-(--rich-block-gap)", "border-l-[3px]")
  })
})

describe("extractAlertFromChildren", () => {
  it("returns null for an ordinary quote", () => {
    expect(extractAlertFromChildren(<p>just a quote</p>)).toBeNull()
    expect(extractAlertFromChildren("plain")).toBeNull()
    expect(extractAlertFromChildren(["\n", "  "])).toBeNull()
  })

  it("detects every GitHub alert type case-insensitively", () => {
    for (const type of ["note", "tip", "important", "warning", "caution"] as const) {
      const result = extractAlertFromChildren(<p>{`[!${type}] body`}</p>)
      expect(result?.type).toBe(type)
    }
  })

  it("strips the marker from the first text leaf and keeps the element tree", () => {
    const result = extractAlertFromChildren([
      "\n",
      <p key="p">
        {"[!CAUTION]\nDo "}
        <em>not</em>
        {" run this"}
      </p>,
      "\n",
      <ul key="ul">
        <li>step</li>
      </ul>,
    ])
    expect(result?.type).toBe("caution")
    const { container } = render(<div>{result?.children}</div>)
    expect(container.textContent).toBe("Do not run thisstep")
    expect(container.querySelector("em")).toHaveTextContent("not")
    expect(container.querySelector("li")).toHaveTextContent("step")
  })

  it("drops a paragraph that held only the marker", () => {
    const result = extractAlertFromChildren([<p key="a">[!IMPORTANT]</p>, <p key="b">body</p>])
    expect(result?.type).toBe("important")
    const { container } = render(<div>{result?.children}</div>)
    expect(container.querySelectorAll("p")).toHaveLength(1)
  })
})
