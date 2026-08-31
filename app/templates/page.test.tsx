import { render, screen } from "@testing-library/react"

let mockCompact = false

jest.mock("@/components/templates/template-studio", () => ({
  TemplateStudio: () => <div data-testid="template-studio-page" />,
}))
jest.mock("@/components/mobile/templates/templates-mobile-body", () => ({
  TemplatesMobileBody: () => <div data-testid="templates-mobile-page" />,
}))
jest.mock("@/hooks/ui/use-compact-layout", () => ({
  useCompactLayout: () => mockCompact,
}))

import TemplatesPage from "./page"

describe("TemplatesPage", () => {
  it("mounts the unified Template Studio", () => {
    mockCompact = false
    render(<TemplatesPage />)
    expect(screen.getByTestId("template-studio-page")).toBeInTheDocument()
  })

  it("renders the phone-shaped catalogue on a narrow viewport", () => {
    mockCompact = true
    render(<TemplatesPage />)
    expect(screen.getByTestId("templates-mobile-page")).toBeInTheDocument()
    expect(screen.queryByTestId("template-studio-page")).not.toBeInTheDocument()
  })
})
