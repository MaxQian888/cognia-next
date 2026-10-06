import { render, screen } from "@testing-library/react"
import { RichBlockError } from "./rich-block-error"

describe("RichBlockError", () => {
  it("announces the failure with its detail, action and source", () => {
    render(
      <RichBlockError
        title="Diagram failed to render"
        detail="Parse error on line 2"
        action={<button type="button">Retry</button>}
      >
        <pre>graph TD; A--</pre>
      </RichBlockError>
    )
    const alert = screen.getByRole("alert")
    expect(alert).toHaveAttribute("data-rich-block-error")
    expect(alert).toHaveClass("my-(--rich-block-gap)", "rounded-lg")
    expect(alert).toHaveTextContent("Diagram failed to render")
    expect(alert).toHaveTextContent("Parse error on line 2")
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument()
    expect(alert.querySelector("pre")).toHaveTextContent("graph TD; A--")
  })

  it("renders the title alone", () => {
    render(<RichBlockError title="Broken" />)
    expect(screen.getByRole("alert")).toHaveTextContent("Broken")
  })
})
