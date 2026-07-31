import { render, screen } from "@testing-library/react"

jest.mock("@/components/browser/browser-desktop-body", () => ({
  BrowserDesktopBody: () => <div data-testid="browser-body" />,
}))

import BrowserPage from "./page"

it("renders the browser desktop body", () => {
  render(<BrowserPage />)
  expect(screen.getByTestId("browser-body")).toBeInTheDocument()
})
