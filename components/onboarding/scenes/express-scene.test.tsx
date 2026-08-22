/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/components/chat/motion/motion-reveal", () => ({
  useFlowMotion: () => ({ reduce: false, durationScale: 1 }),
}))

import { ExpressScene, type ExpressSceneItem } from "./express-scene"

const items: ExpressSceneItem[] = [
  { id: "migrate", state: "done" },
  { id: "history", state: "running" },
  { id: "runtime", state: "queued" },
  { id: "capabilities", state: "skipped" },
]

describe("ExpressScene", () => {
  it("draws one node per plan line", () => {
    render(<ExpressScene items={items} />)
    for (const item of items) {
      expect(screen.getByTestId(`onboarding-scene-item-${item.id}`)).toBeInTheDocument()
    }
  })

  it("shows an armed line as armed, not as inert", () => {
    // Drawing a selected line the same grey as a dropped one made a full plan
    // look like an empty one.
    render(<ExpressScene items={items} />)
    expect(screen.getByTestId("onboarding-scene-item-runtime")).toHaveAttribute(
      "data-tone",
      "ready"
    )
    expect(screen.getByTestId("onboarding-scene-item-capabilities")).toHaveAttribute(
      "data-tone",
      "idle"
    )
  })

  it("dashes only what has been dropped", () => {
    const { container } = render(<ExpressScene items={items} />)
    const dashed = Array.from(container.querySelectorAll("g[data-tone] rect[stroke-dasharray]"))
    // Every padding row is dashed too, so assert on the real lines instead.
    const queued = screen.getByTestId("onboarding-scene-item-runtime").querySelector("rect")
    const dropped = screen.getByTestId("onboarding-scene-item-capabilities").querySelector("rect")
    expect(queued).not.toHaveAttribute("stroke-dasharray")
    expect(dropped).toHaveAttribute("stroke-dasharray")
    expect(dashed.length).toBeGreaterThan(0)
  })

  it("connects only the lines that have actually started", () => {
    // A queued or dropped line has no connector at all: the picture must not
    // claim work is flowing that has not begun.
    render(<ExpressScene items={items} />)
    expect(screen.getByTestId("onboarding-scene-link-migrate")).toBeInTheDocument()
    expect(screen.getByTestId("onboarding-scene-link-history")).toBeInTheDocument()
    expect(screen.queryByTestId("onboarding-scene-link-runtime")).toBeNull()
    expect(screen.queryByTestId("onboarding-scene-link-capabilities")).toBeNull()
  })

  it("pops a line the moment it lands rather than waiting out the stagger", () => {
    const { rerender } = render(<ExpressScene items={[{ id: "migrate", state: "queued" }]} />)
    const queued = screen.getByTestId("onboarding-scene-item-migrate")
    rerender(<ExpressScene items={[{ id: "migrate", state: "done" }]} />)
    const done = screen.getByTestId("onboarding-scene-item-migrate")
    // A fresh node, so the entrance replays…
    expect(done).not.toBe(queued)
    // …and it replays immediately, because it is reacting to an event rather
    // than entering with the rest of the scene.
    expect(done.getAttribute("style")).toContain("animation-delay: 0ms")
  })

  it("keeps a short plan from collapsing to a stub", () => {
    render(<ExpressScene items={[{ id: "sign-in", state: "queued" }]} />)
    expect(screen.getByTestId("onboarding-scene-item-pad-0")).toBeInTheDocument()
    expect(screen.getByTestId("onboarding-scene-item-pad-1")).toBeInTheDocument()
  })

  it("keeps the core dark until something has actually landed", () => {
    const { rerender } = render(<ExpressScene items={[{ id: "migrate", state: "running" }]} />)
    expect(screen.getByTestId("scene-core")).toHaveAttribute("data-active", "false")

    rerender(<ExpressScene items={[{ id: "migrate", state: "done" }]} />)
    expect(screen.getByTestId("scene-core")).toHaveAttribute("data-active", "true")
  })

  it("shows the summary badge only when the caller has one", () => {
    const { rerender } = render(<ExpressScene items={items} />)
    expect(screen.queryByTestId("onboarding-scene-done-count")).toBeNull()

    rerender(<ExpressScene items={items} doneLabel="3" />)
    expect(screen.getByTestId("onboarding-scene-done-count")).toBeInTheDocument()
  })
})
