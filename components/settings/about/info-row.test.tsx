/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import { InfoRow } from "./info-row"

describe("<InfoRow />", () => {
  it("renders label and value", () => {
    render(<InfoRow label="Version" value="1.2.3" testid="r" />)
    const row = screen.getByTestId("r")
    expect(row).toHaveTextContent("Version")
    expect(row).toHaveTextContent("1.2.3")
  })

  it("applies monospace styling when mono is set", () => {
    render(<InfoRow label="L" value="V" mono testid="r" />)
    expect(screen.getByTestId("r").querySelector(".font-mono")).not.toBeNull()
  })

  it("omits monospace styling by default", () => {
    render(<InfoRow label="L" value="V" testid="r" />)
    expect(screen.getByTestId("r").querySelector(".font-mono")).toBeNull()
  })
})
