/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

import { PasswordStrengthMeter } from "./password-strength-meter"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

describe("PasswordStrengthMeter", () => {
  it("renders nothing for an empty password", () => {
    const { container } = render(<PasswordStrengthMeter password="" />)
    expect(container).toBeEmptyDOMElement()
  })

  it("labels a too-short password and shows a zero score", () => {
    render(<PasswordStrengthMeter password="abc" />)
    expect(screen.getByTestId("password-strength-meter")).toHaveAttribute("data-score", "0")
    expect(screen.getByTestId("password-strength-label")).toHaveTextContent("tooShort")
  })

  it("labels a strong password and shows the max score", () => {
    render(<PasswordStrengthMeter password="Abcdef123456!@#$" />)
    expect(screen.getByTestId("password-strength-meter")).toHaveAttribute("data-score", "4")
    expect(screen.getByTestId("password-strength-label")).toHaveTextContent("strong")
  })

  it("applies a custom class name to the wrapper", () => {
    render(<PasswordStrengthMeter password="aaaaaaaa" className="mt-2" />)
    expect(screen.getByTestId("password-strength-meter")).toHaveClass("mt-2")
  })
})
