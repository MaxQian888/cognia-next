/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
}))

jest.mock("../tabs/typography-tab", () => ({
  TypographyTab: () => <div data-testid="typography-tab" />,
}))
jest.mock("../tabs/layout-tab", () => ({
  LayoutTab: () => <div data-testid="layout-tab" />,
}))

import { AppearanceTypographyPanel } from "./typography-panel"

describe("AppearanceTypographyPanel", () => {
  it("hosts type and density together", () => {
    render(<AppearanceTypographyPanel />)
    expect(screen.getByTestId("typography-tab")).toBeInTheDocument()
    expect(screen.getByTestId("layout-tab")).toBeInTheDocument()
  })

  it("labels each section so the merge stays scannable", () => {
    render(<AppearanceTypographyPanel />)
    expect(screen.getByRole("heading", { name: "fontsTitle" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "layoutTitle" })).toBeInTheDocument()
  })
})
