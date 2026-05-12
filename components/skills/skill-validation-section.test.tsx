/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

import { render, screen } from "@testing-library/react"
import { SkillValidationSection } from "./skill-validation-section"

describe("SkillValidationSection", () => {
  it("renders the empty state when there are no errors", () => {
    render(<SkillValidationSection errors={[]} />)
    expect(screen.getByText("empty")).toBeInTheDocument()
  })

  it("renders each error with field, message, and code", () => {
    render(
      <SkillValidationSection
        errors={[
          { code: "missing-name", field: "name", message: "Name is required." },
          { code: "name-too-long", field: "name", message: "Too long." },
        ]}
      />
    )
    expect(screen.getByText("Name is required.")).toBeInTheDocument()
    expect(screen.getByText("Too long.")).toBeInTheDocument()
    expect(screen.getByText("missing-name")).toBeInTheDocument()
  })

  it("groups errors by field", () => {
    render(
      <SkillValidationSection
        errors={[
          { code: "missing-name", field: "name", message: "A" },
          { code: "name-too-long", field: "name", message: "B" },
          { code: "description-too-long", field: "description", message: "C" },
        ]}
      />
    )
    const groups = screen.getAllByRole("group")
    expect(groups).toHaveLength(2)
  })
})
