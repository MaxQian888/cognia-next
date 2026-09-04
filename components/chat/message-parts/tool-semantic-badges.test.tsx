import { render, screen } from "@testing-library/react"

import { ToolSemanticBadges } from "./tool-semantic-badges"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

describe("ToolSemanticBadges", () => {
  /**
   * The badge reports a CAPABILITY the tool protocol declared, not what a call
   * did. A tool that never says whether it writes has not said it is read-only,
   * and rendering "Read only" for a missing hint would be an assurance nobody
   * gave. Both spellings of absent have to stay silent.
   */
  it.each([[undefined], [null]])("renders nothing when the hint is %p", (hint) => {
    const { container } = render(<ToolSemanticBadges readOnlyHint={hint} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("marks a declared read-only tool", () => {
    render(<ToolSemanticBadges readOnlyHint />)
    expect(screen.getByTestId("tool-readonly")).toHaveTextContent("readOnly")
    expect(screen.queryByTestId("tool-write-capable")).not.toBeInTheDocument()
  })

  it("marks a tool that can modify", () => {
    render(<ToolSemanticBadges readOnlyHint={false} />)
    expect(screen.getByTestId("tool-write-capable")).toHaveTextContent("writeCapable")
    expect(screen.queryByTestId("tool-readonly")).not.toBeInTheDocument()
  })
})
