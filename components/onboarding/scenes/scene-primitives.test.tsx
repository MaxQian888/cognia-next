/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

let reduce = false
jest.mock("@/components/chat/motion/motion-reveal", () => ({
  useFlowMotion: () => ({ reduce, durationScale: 1 }),
}))

import {
  CHIP,
  CORE,
  Connector,
  CoreNode,
  CountBadge,
  MachineFrame,
  SceneCanvas,
  SlotChip,
  TONE_MARK,
  TONE_STROKE,
  chipCenterY,
} from "./scene-primitives"

beforeEach(() => {
  reduce = false
})

const canvas = (children: React.ReactNode) =>
  render(<SceneCanvas label="scene">{children}</SceneCanvas>)

describe("chipCenterY", () => {
  it("centres a column of any length on the core's own row", () => {
    // The core never moves between steps, so a one-item column has to sit on
    // its axis or the connector reads as a branch rather than a link.
    expect(chipCenterY(0, 1)).toBe(CORE.y)
  })

  it("distributes rows evenly around the core", () => {
    const [a, b, c] = [chipCenterY(0, 3), chipCenterY(1, 3), chipCenterY(2, 3)]
    expect(b).toBe(CORE.y)
    expect(CORE.y - a).toBeCloseTo(c - CORE.y)
    expect(b - a).toBe(CHIP.height + CHIP.gap)
  })
})

describe("SceneCanvas", () => {
  it("labels the geometry rather than exposing it", () => {
    // A scene is a decorative restatement of what the step body already says
    // in text, so it gets a short label, not a description of every node.
    canvas(<g />)
    expect(screen.getByRole("img", { name: "scene" })).toBeInTheDocument()
  })
})

describe("entrance", () => {
  it("animates in by default", () => {
    canvas(<MachineFrame />)
    expect(screen.getByTestId("scene-machine").getAttribute("class")).toContain("animate-in")
  })

  it("holds the start frame through the stagger delay", () => {
    // Without `fill-mode-backwards` the element would flash at its final state
    // during the delay and then jump back to the start.
    canvas(<MachineFrame />)
    expect(screen.getByTestId("scene-machine").getAttribute("class")).toContain(
      "fill-mode-backwards"
    )
  })

  it("emits no animation at all when motion is reduced", () => {
    // A delay is not covered by the `animation-duration: 1ms` guards in
    // globals.css, so a reduce-motion user would otherwise stare at a blank
    // panel for the length of the stagger.
    reduce = true
    canvas(<MachineFrame />)
    const el = screen.getByTestId("scene-machine")
    expect(el.getAttribute("class")).toBeNull()
    expect(el.getAttribute("style")).toBeNull()
  })
})

describe("CoreNode", () => {
  it("draws no halo until the flow has something real to show", () => {
    canvas(<CoreNode />)
    expect(screen.getByTestId("scene-core")).toHaveAttribute("data-active", "false")
    expect(screen.queryByTestId("scene-core-halo")).toBeNull()
  })

  it("breathes once it is live, so a settled scene is not a still life", () => {
    canvas(<CoreNode active />)
    expect(screen.getByTestId("scene-core-halo").getAttribute("class")).toContain(
      "onboarding-breathe"
    )
  })

  it("stops breathing when motion is reduced", () => {
    reduce = true
    canvas(<CoreNode active />)
    expect(screen.getByTestId("scene-core-halo").getAttribute("class")).toBeNull()
  })
})

describe("SlotChip", () => {
  it("distinguishes armed from finished without relying on colour", () => {
    // `ready` and `active` share a hue; the shape is what separates them, and
    // it has to, because colour alone is not a state signal.
    const { container: ready } = canvas(<SlotChip index={0} total={1} tone="ready" />)
    const { container: done } = canvas(<SlotChip index={0} total={1} tone="active" done />)
    expect(ready.querySelector("circle")).not.toBeNull()
    expect(ready.querySelector("path")).toBeNull()
    expect(done.querySelector("path")).not.toBeNull()
  })

  it("gives an armed line a brand mark on a neutral frame", () => {
    // "Will run" and "has run" must not look alike on a screen whose whole
    // promise is that nothing has happened yet.
    expect(TONE_STROKE.ready).toBe(TONE_STROKE.idle)
    expect(TONE_MARK.ready).toBe(TONE_MARK.active)
  })

  it("lets a reacting chip skip the stagger meant for the first paint", () => {
    canvas(<SlotChip index={3} total={4} tone="active" entranceIndex={0} data-testid="chip" />)
    expect(screen.getByTestId("chip").getAttribute("style")).toContain("animation-delay: 0ms")
  })
})

describe("Connector", () => {
  it("normalises its length so one keyframe serves any geometry", () => {
    const { container } = canvas(<Connector index={0} total={1} tone="active" data-testid="link" />)
    expect(container.querySelector("path")).toHaveAttribute("pathLength", "1")
    expect(screen.getByTestId("link").getAttribute("class")).toContain("onboarding-draw")
  })

  it("flows rather than draws while the work is in flight", () => {
    // A dashed line cannot also draw itself on — both want `stroke-dasharray`
    // — so an in-flight connector gets the motion that suits it.
    const { container } = canvas(
      <Connector index={0} total={1} tone="pending" dashed data-testid="link" />
    )
    expect(screen.getByTestId("link").getAttribute("class")).toContain("onboarding-flow")
    expect(container.querySelector("path")).not.toHaveAttribute("pathLength")
  })

  it("carries no animation when motion is reduced", () => {
    reduce = true
    canvas(<Connector index={0} total={1} tone="active" data-testid="link" />)
    expect(screen.getByTestId("link").getAttribute("class")).toBeNull()
  })
})

describe("CountBadge", () => {
  it("shows the number as text, since a count drawn as bars is taken on faith", () => {
    canvas(<CountBadge value="128" data-testid="badge" />)
    expect(screen.getByText("128")).toBeInTheDocument()
  })

  it("replays when the number moves", () => {
    const { rerender } = render(
      <SceneCanvas label="scene">
        <CountBadge value="12" data-testid="badge" />
      </SceneCanvas>
    )
    const first = screen.getByTestId("badge")
    rerender(
      <SceneCanvas label="scene">
        <CountBadge value="128" data-testid="badge" />
      </SceneCanvas>
    )
    expect(screen.getByTestId("badge")).not.toBe(first)
  })
})
