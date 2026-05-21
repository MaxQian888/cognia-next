/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

import { BiometricRow } from "./biometric-row"

describe("<BiometricRow />", () => {
  it("renders the label + help text + Switch with the supplied testid", () => {
    render(
      <BiometricRow
        label="Delete pairing"
        help="Confirm with Face ID before unpairing"
        checked
        onChange={() => undefined}
        testid="biometric-delete-pairing"
      />
    )
    expect(screen.getByText("Delete pairing")).toBeInTheDocument()
    expect(screen.getByText("Confirm with Face ID before unpairing")).toBeInTheDocument()
    const sw = screen.getByTestId("biometric-delete-pairing")
    expect(sw).toHaveAttribute("data-state", "checked")
    expect(sw).toHaveAttribute("aria-label", "Delete pairing")
  })

  it("renders an unchecked switch when checked=false", () => {
    render(
      <BiometricRow
        label="Reveal secrets"
        help="Re-prompt before showing tokens"
        checked={false}
        onChange={() => undefined}
        testid="biometric-reveal-secrets"
      />
    )
    expect(screen.getByTestId("biometric-reveal-secrets")).toHaveAttribute(
      "data-state",
      "unchecked"
    )
  })

  it("invokes onChange with the new value when clicked", () => {
    const onChange = jest.fn()
    render(
      <BiometricRow
        label="Export backup"
        help="Re-prompt before exporting"
        checked={false}
        onChange={onChange}
        testid="biometric-export-backup"
      />
    )
    fireEvent.click(screen.getByTestId("biometric-export-backup"))
    expect(onChange).toHaveBeenCalledWith(true)
  })
})
