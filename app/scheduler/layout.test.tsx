/**
 * @jest-environment jsdom
 */

import { render } from "@testing-library/react"
import SchedulerLayout, { metadata } from "./layout"

describe("SchedulerLayout", () => {
  it("renders children unchanged", () => {
    const { getByTestId } = render(
      <SchedulerLayout>
        <span data-testid="child">hi</span>
      </SchedulerLayout>
    )
    expect(getByTestId("child")).toBeInTheDocument()
  })

  it("exports a Metadata object with a title and description", () => {
    expect(metadata.title).toBe("Task Scheduler - Cognia")
    expect(typeof metadata.description).toBe("string")
  })
})
