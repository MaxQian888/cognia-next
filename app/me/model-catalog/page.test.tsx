/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
jest.mock("@/components/mobile/me/sub-page-shell", () => ({
  SubPageShell: ({
    children,
    title,
    testid,
  }: {
    children: React.ReactNode
    title: string
    testid: string
  }) => (
    <main data-testid={testid}>
      <h1>{title}</h1>
      {children}
    </main>
  ),
}))
jest.mock("@/components/settings/provider/model-catalog-section", () => ({
  ModelCatalogSection: () => <div data-testid="shared-model-catalog" />,
}))

import MobileModelCatalogPage from "./page"

describe("MobileModelCatalogPage", () => {
  it("reuses the shared catalog with a mobile full-screen shell", () => {
    render(<MobileModelCatalogPage />)

    expect(screen.getByTestId("mobile-model-catalog-page")).toBeInTheDocument()
    expect(screen.getByTestId("shared-model-catalog")).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "title" })).toBeInTheDocument()
  })
})
