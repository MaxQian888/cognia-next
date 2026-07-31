import { render, screen } from "@testing-library/react"

jest.mock("@/components/feature-shell/feature-page-shell", () => ({
  FeaturePageShell: ({
    header,
    children,
  }: {
    header: React.ReactNode
    children: React.ReactNode
  }) => (
    <div>
      <div data-testid="header">{header}</div>
      {children}
    </div>
  ),
}))
jest.mock("@/components/browser/browser-preview-pane", () => ({
  BrowserPreviewPane: () => <div data-testid="pane" />,
}))

import { BrowserDesktopBody } from "./browser-desktop-body"

it("renders the title and the preview pane inside the shell", () => {
  render(<BrowserDesktopBody />)
  expect(screen.getByTestId("header")).toHaveTextContent("Browser")
  expect(screen.getByTestId("pane")).toBeInTheDocument()
})
