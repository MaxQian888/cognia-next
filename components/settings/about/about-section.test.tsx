/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

jest.mock("./about-hero", () => ({ AboutHero: () => <div data-testid="s-hero" /> }))
jest.mock("./version-build-card", () => ({
  VersionBuildCard: () => <div data-testid="s-version" />,
}))
jest.mock("./system-diagnostics-card", () => ({
  SystemDiagnosticsCard: () => <div data-testid="s-system" />,
}))
jest.mock("./update-card", () => ({ UpdateCard: () => <div data-testid="s-update" /> }))
jest.mock("./whats-new-card", () => ({ WhatsNewCard: () => <div data-testid="s-whatsnew" /> }))
jest.mock("./resources-card", () => ({ ResourcesCard: () => <div data-testid="s-resources" /> }))
jest.mock("./legal-credits-card", () => ({ LegalCreditsCard: () => <div data-testid="s-legal" /> }))

import { AboutSection } from "./about-section"

describe("<AboutSection />", () => {
  it("composes the hero and every card in order", () => {
    render(<AboutSection />)
    expect(screen.getByTestId("about-section")).toBeInTheDocument()
    for (const id of [
      "s-hero",
      "s-version",
      "s-system",
      "s-update",
      "s-whatsnew",
      "s-resources",
      "s-legal",
    ]) {
      expect(screen.getByTestId(id)).toBeInTheDocument()
    }
  })
})
