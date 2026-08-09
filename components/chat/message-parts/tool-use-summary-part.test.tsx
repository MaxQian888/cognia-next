/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"

import { ToolUseSummaryPart } from "./tool-use-summary-part"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

describe("ToolUseSummaryPart", () => {
  it("renders the model summary without exposing correlated tool ids", () => {
    render(
      <ToolUseSummaryPart
        part={{
          type: "data-tool-summary",
          data: { summary: "Read two files", toolCallIds: ["t1", "t2"] },
        }}
      />
    )

    expect(screen.getByTestId("tool-use-summary")).toHaveTextContent("Read two files")
    expect(screen.getByTestId("tool-use-summary")).not.toHaveAttribute("data-tool-call-ids")
    expect(screen.queryByText("t1")).toBeNull()
    expect(screen.queryByText("t2")).toBeNull()
    expect(screen.getByRole("complementary")).toHaveAccessibleName("ariaLabel")
  })

  it("does not render an empty summary", () => {
    const { container } = render(
      <ToolUseSummaryPart
        part={{ type: "data-tool-summary", data: { summary: "  ", toolCallIds: [] } }}
      />
    )
    expect(container).toBeEmptyDOMElement()
  })
})
