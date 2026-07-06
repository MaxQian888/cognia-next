/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/components/settings/artifacts-section", () => ({
  ArtifactsSection: () => <div data-testid="stub-artifacts" />,
}))

import Page from "./page"

describe("MobileArtifactsPage", () => {
  it("renders the Artifacts section inside the shell", () => {
    render(<Page />)
    expect(screen.getByTestId("mobile-artifacts-page")).toBeInTheDocument()
    expect(screen.getByTestId("stub-artifacts")).toBeInTheDocument()
  })
})
