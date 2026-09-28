/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import { FilesMobileUnsupported } from "./files-mobile-unsupported"

it("explains that Files is not built for the phone and names the dormancy reason", () => {
  render(<FilesMobileUnsupported />)
  expect(screen.getByText("Files isn’t available on the phone yet")).toBeInTheDocument()
  expect(screen.getByTestId("files-mobile-unsupported")).toHaveAttribute(
    "data-dormant-reason",
    "phone-shell-not-built"
  )
})
