/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { NarrativePanel } from "./narrative-panel"
import { resolveStepSequence } from "@/lib/onboarding/steps"

const seq = resolveStepSequence({ shell: "tauri", mode: "custom", hasModelAccess: false })
const scene = <svg data-testid="test-scene" />

const renderPanel = (props: Partial<Parameters<typeof NarrativePanel>[0]> = {}) =>
  render(<NarrativePanel scene={scene} sceneKey="scan" sequence={seq} current="scan" {...props} />)

describe("NarrativePanel", () => {
  it("renders the step's scene", () => {
    renderPanel()
    expect(screen.getByTestId("test-scene")).toBeInTheDocument()
  })

  it("reads its copy from the current step", () => {
    renderPanel()
    expect(screen.getByTestId("onboarding-narrative-headline")).toHaveTextContent(
      "narrative.scan.headline"
    )
  })

  it("lets one step say more than one thing", () => {
    // The recommended screen promises "nothing runs until you say so" while it
    // is showing the plan, which becomes a lie the moment it starts running it.
    renderPanel({ current: "express", narrativeKey: "express-applying" })
    expect(screen.getByTestId("onboarding-narrative-headline")).toHaveTextContent(
      "narrative.express-applying.headline"
    )
  })

  it("exists at every width rather than handing off to a separate bar", () => {
    // The predecessor hid its rail below `md` and rendered a second progress
    // strip instead — two components, two testids, one job.
    const { container } = renderPanel()
    const panel = screen.getByTestId("onboarding-narrative-panel")
    expect(panel.className).toContain("w-full")
    expect(panel.className).toContain("md:w-[26rem]")
    // It becomes a band across the top below `md`, and a column above it.
    expect(panel.className).toContain("border-b")
    expect(panel.className).toContain("md:border-r")
    expect(container.querySelectorAll('[data-testid="onboarding-narrative-panel"]')).toHaveLength(1)
  })

  it("carries the stepper by default and drops it on request", () => {
    renderPanel()
    expect(screen.getByTestId("onboarding-stepper")).toBeInTheDocument()

    renderPanel({ showStepper: false })
    expect(screen.getAllByTestId("onboarding-stepper")).toHaveLength(1)
  })

  it("keeps the brand tint off the text layer", () => {
    // `--brand-action` is 1.69:1 on a light substrate (ADR-0092 V2 §8), so it
    // is a substrate and a stroke here and never a text colour.
    renderPanel()
    const headline = screen.getByTestId("onboarding-narrative-headline")
    expect(headline.className).toContain("text-foreground")
    expect(headline.className).not.toContain("text-brand")
  })

  it("hides the mesh from assistive tech and from the pointer", () => {
    const { container } = renderPanel()
    const mesh = container.querySelector('[aria-hidden="true"].pointer-events-none')
    expect(mesh).not.toBeNull()
  })
})
