/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/components/chat/motion/motion-reveal", () => ({
  useFlowMotion: () => ({ reduce: false, durationScale: 1 }),
}))

import { WelcomeScene } from "./welcome-scene"

describe("WelcomeScene", () => {
  it("names the three things a chat box cannot reach", () => {
    render(<WelcomeScene />)
    for (const id of ["fs", "screen", "web"]) {
      expect(screen.getByTestId(`onboarding-scene-chip-${id}`)).toBeInTheDocument()
    }
  })

  it("draws all three connected — this screen is a claim, not a report", () => {
    // The *report* is the next scene, and it lights only what the probe found.
    render(<WelcomeScene />)
    for (const id of ["fs", "screen", "web"]) {
      expect(screen.getByTestId(`onboarding-scene-link-${id}`)).toHaveAttribute(
        "data-tone",
        "active"
      )
    }
  })

  it("shares the machine frame and core with every other scene", () => {
    // The continuity is the point: the silhouette learned here is the one the
    // user keeps seeing as they move through the flow.
    render(<WelcomeScene />)
    expect(screen.getByTestId("scene-machine")).toBeInTheDocument()
    expect(screen.getByTestId("scene-core")).toHaveAttribute("data-active", "true")
  })

  it("is announced as one label rather than as geometry", () => {
    render(<WelcomeScene />)
    expect(screen.getByRole("img", { name: "scene.welcome" })).toBeInTheDocument()
  })
})
