/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/components/chat/motion/motion-reveal", () => ({
  useFlowMotion: () => ({ reduce: false, durationScale: 1 }),
}))

import { ProviderScene } from "./provider-scene"

describe("ProviderScene", () => {
  it("draws one chip, not a column with empty slots under it", () => {
    // Every other step is about plurality; this one is about a single missing
    // piece, so the composition says so.
    const { container } = render(<ProviderScene />)
    expect(container.querySelectorAll("g[data-tone]")).toHaveLength(1)
  })

  it("reads as pending until a credential lands", () => {
    // The same tone ladder the scan scene uses for an installed-but-
    // unauthenticated runtime: "present but not signed in" and "not signed in
    // yet" are the same state, and the flow should not invent a second visual
    // language for it one step later.
    render(<ProviderScene />)
    expect(screen.getByTestId("onboarding-scene-credential")).toHaveAttribute(
      "data-tone",
      "pending"
    )
    expect(screen.getByTestId("onboarding-scene-link-credential")).toHaveAttribute(
      "stroke-dasharray"
    )
    expect(screen.getByTestId("scene-core")).toHaveAttribute("data-active", "false")
  })

  it("completes the link once connected", () => {
    render(<ProviderScene connected />)
    expect(screen.getByTestId("onboarding-scene-credential")).toHaveAttribute("data-tone", "active")
    expect(screen.getByTestId("onboarding-scene-link-credential")).not.toHaveAttribute(
      "stroke-dasharray"
    )
    expect(screen.getByTestId("scene-core")).toHaveAttribute("data-active", "true")
  })
})
