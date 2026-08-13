/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react"

import { GroundingPart } from "./grounding-part"

describe("GroundingPart", () => {
  it("renders unsupported claims as an expandable warning", () => {
    render(
      <GroundingPart
        part={{
          type: "grounding",
          supportRatio: 0.5,
          action: "annotate",
          claims: [
            {
              id: "claim-1",
              text: "Unsupported fact.",
              startOffset: 0,
              endOffset: 17,
              supported: false,
              hitIds: [],
            },
          ],
        }}
      />
    )

    expect(screen.getByTestId("grounding-unsupported")).toHaveTextContent("Unsupported fact.")
  })

  it("renders a supported status when every claim is grounded", () => {
    render(
      <GroundingPart
        part={{
          type: "grounding",
          supportRatio: 1,
          action: "allow",
          claims: [],
        }}
      />
    )

    expect(screen.getByTestId("grounding-supported")).toBeTruthy()
  })
})
