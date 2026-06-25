import { render, screen } from "@testing-library/react"

jest.mock("@/components/feature-shell/feature-page-shell", () => ({
  FeaturePageShell: ({
    toolbar,
    children,
  }: {
    toolbar: React.ReactNode
    children: React.ReactNode
  }) => (
    <div>
      <div data-testid="toolbar">{toolbar}</div>
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
  expect(screen.getByTestId("toolbar")).toHaveTextContent("Browser")
  expect(screen.getByTestId("pane")).toBeInTheDocument()
})
