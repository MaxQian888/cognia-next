/**
 * @jest-environment jsdom
 */

import { render } from "@testing-library/react"
import ShareTargetLayout, { metadata } from "./layout"

describe("ShareTargetLayout", () => {
  it("renders children unchanged", () => {
    const { getByTestId } = render(
      <ShareTargetLayout>
        <span data-testid="child">hi</span>
      </ShareTargetLayout>
    )
    expect(getByTestId("child")).toBeInTheDocument()
  })

  it("exports a Metadata object with a title and description", () => {
    expect(metadata.title).toBe("Share to Cognia")
    expect(typeof metadata.description).toBe("string")
    expect((metadata.description as string).length).toBeGreaterThan(0)
  })
})
