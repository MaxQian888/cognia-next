/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
}))

import { AppearancePreview } from "./appearance-preview"

describe("AppearancePreview", () => {
  it("renders the sample surfaces", () => {
    render(<AppearancePreview />)
    expect(screen.getByTestId("appearance-preview")).toBeInTheDocument()
    // A button of every variant + the chat bubbles + the code line are present.
    expect(screen.getByText("buttons.primary")).toBeInTheDocument()
    expect(screen.getByText("buttons.destructive")).toBeInTheDocument()
    expect(screen.getByText("assistant")).toBeInTheDocument()
    expect(screen.getByText("user")).toBeInTheDocument()
    expect(screen.getByText("code")).toBeInTheDocument()
  })

  it("shows an accessible, non-interactive switch and input", () => {
    render(<AppearancePreview />)
    expect(screen.getByRole("switch", { name: "switchAria" })).toBeChecked()
    expect(screen.getByLabelText("inputAria")).toHaveAttribute("readonly")
  })

  it("forwards a className to the root", () => {
    render(<AppearancePreview className="custom-x" />)
    expect(screen.getByTestId("appearance-preview")).toHaveClass("custom-x")
  })
})
