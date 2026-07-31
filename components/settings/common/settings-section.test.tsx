/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import { SettingsPageHeader } from "./settings-section"

describe("SettingsPageHeader", () => {
  it("uses the shared first-viewport hierarchy while preserving section semantics", () => {
    render(
      <SettingsPageHeader
        title="Evaluation"
        description="Configure judge defaults"
        icon={<svg data-testid="section-icon" />}
        actions={<button type="button">Reset</button>}
      />
    )

    expect(screen.getByRole("heading", { level: 2, name: "Evaluation" })).toBeInTheDocument()
    expect(screen.getByText("Configure judge defaults")).toBeInTheDocument()
    expect(screen.getByTestId("section-icon")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Reset" })).toBeInTheDocument()
  })
})
