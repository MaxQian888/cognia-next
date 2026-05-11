/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { render, screen } from "@testing-library/react"
import { SkillValidationPanel } from "./skill-validation-panel"

describe("SkillValidationPanel", () => {
  it("renders live errors when the draft name is empty", () => {
    render(<SkillValidationPanel draft={{ name: "", content: "x" }} resources={[]} />)
    expect(screen.getByText(/Name is required/i)).toBeInTheDocument()
  })

  it("renders empty state when the draft is valid", () => {
    render(<SkillValidationPanel draft={{ name: "Good Name", content: "x" }} resources={[]} />)
    expect(screen.getByText("empty")).toBeInTheDocument()
  })
})
