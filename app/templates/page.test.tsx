import { render, screen } from "@testing-library/react"

jest.mock("@/components/templates/template-studio", () => ({
  TemplateStudio: () => <div data-testid="template-studio-page" />,
}))

import TemplatesPage from "./page"

describe("TemplatesPage", () => {
  it("mounts the unified Template Studio", () => {
    render(<TemplatesPage />)
    expect(screen.getByTestId("template-studio-page")).toBeInTheDocument()
  })
})
