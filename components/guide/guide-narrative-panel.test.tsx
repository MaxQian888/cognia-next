/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react"

import { GuideNarrativePanel } from "./guide-narrative-panel"

const scene = <svg data-testid="scene" />

const renderPanel = (props: Partial<Parameters<typeof GuideNarrativePanel>[0]> = {}) =>
  render(
    <GuideNarrativePanel
      scene={scene}
      sceneKey="one"
      headline="Looking around."
      body="Nothing leaves your computer."
      testIdPrefix="flow"
      {...props}
    />
  )

describe("GuideNarrativePanel", () => {
  it("renders the scene, the headline and the line under it", () => {
    renderPanel()
    expect(screen.getByTestId("flow-scene-slot")).toContainElement(screen.getByTestId("scene"))
    expect(screen.getByTestId("flow-narrative-headline")).toHaveTextContent("Looking around.")
    expect(screen.getByTestId("flow-narrative-body")).toHaveTextContent("Nothing leaves")
  })

  it("narrates rather than titles — the page heading belongs to the step body", () => {
    renderPanel()
    expect(screen.queryByRole("heading")).toBeNull()
  })

  it("keeps brand colour off the text layer", () => {
    // `--brand-action` is 1.69:1 on a light substrate (ADR-0092 V2 §8).
    renderPanel()
    const headline = screen.getByTestId("flow-narrative-headline")
    expect(headline).toHaveClass("text-foreground")
    expect(headline.className).not.toContain("text-brand")
  })

  it("crossfades the scene and the copy by key, replaying their entrances", () => {
    const { rerender } = renderPanel()
    const firstScene = screen.getByTestId("flow-scene-slot")
    expect(firstScene.className).toContain("animate-in")
    rerender(
      <GuideNarrativePanel scene={scene} sceneKey="two" headline="Next." testIdPrefix="flow" />
    )
    expect(screen.getByTestId("flow-scene-slot")).not.toBe(firstScene)
  })

  it("caps its height below `md` as a band, dropping the supporting line first", () => {
    renderPanel({ overflow: "band" })
    const panel = screen.getByTestId("flow-narrative-panel")
    expect(panel).toHaveClass("h-[30vh]", "overflow-hidden", "md:w-[26rem]", "md:border-r")
    expect(screen.getByTestId("flow-narrative-body")).toHaveClass("hidden", "sm:block")
  })

  it("scrolls with the page below `md` when it carries real material", () => {
    renderPanel({ overflow: "scroll" })
    const panel = screen.getByTestId("flow-narrative-panel")
    expect(panel).not.toHaveClass("h-[30vh]")
    expect(panel).toHaveAttribute("data-overflow", "scroll")
    expect(screen.getByTestId("flow-narrative-body")).not.toHaveClass("hidden")
  })

  it("puts status, stepper and aside inside the panel, and omits the ones not given", () => {
    const { unmount } = renderPanel({
      status: <div data-testid="status" />,
      stepper: <nav data-testid="stepper" />,
      aside: <div data-testid="aside" />,
    })
    const panel = screen.getByTestId("flow-narrative-panel")
    for (const id of ["status", "stepper", "aside"]) {
      expect(panel).toContainElement(screen.getByTestId(id))
    }
    unmount()

    renderPanel()
    expect(screen.queryByTestId("stepper")).toBeNull()
    expect(screen.queryByTestId("aside")).toBeNull()
  })

  it("omits the body line when there is none", () => {
    renderPanel({ body: undefined })
    expect(screen.queryByTestId("flow-narrative-body")).toBeNull()
  })

  it("paints the shared brand substrate", () => {
    const { container } = renderPanel()
    expect(container.querySelector('[data-slot="guide-brand-mesh"]')).not.toBeNull()
  })
})
