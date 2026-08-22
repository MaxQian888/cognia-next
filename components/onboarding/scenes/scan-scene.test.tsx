/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

let reduce = false
jest.mock("@/components/chat/motion/motion-reveal", () => ({
  useFlowMotion: () => ({ reduce, durationScale: 1 }),
}))

import { MAX_SLOTS, ScanScene } from "./scan-scene"
import type { ScannedRuntime } from "@/lib/onboarding/scan"

const SIGNED_IN: ScannedRuntime = { id: "claude-code", label: "Claude Code", authenticated: true }
const INSTALLED: ScannedRuntime = { id: "codex", label: "Codex", authenticated: false }

beforeEach(() => {
  reduce = false
})

describe("ScanScene", () => {
  it("lights one node per runtime the probe actually found", () => {
    // The reason the panel earns its width: this is a report about *this*
    // machine, not a claim about the product.
    render(<ScanScene phase="found" runtimes={[SIGNED_IN, INSTALLED]} />)
    expect(screen.getByTestId("onboarding-scene-runtime-claude-code")).toBeInTheDocument()
    expect(screen.getByTestId("onboarding-scene-runtime-codex")).toBeInTheDocument()
  })

  it("separates signed-in from merely installed", () => {
    // The same distinction the step body draws in words, and the reason the
    // flow can skip the sign-in step for one and not the other.
    render(<ScanScene phase="found" runtimes={[SIGNED_IN, INSTALLED]} />)
    expect(screen.getByTestId("onboarding-scene-runtime-claude-code")).toHaveAttribute(
      "data-tone",
      "active"
    )
    expect(screen.getByTestId("onboarding-scene-runtime-codex")).toHaveAttribute(
      "data-tone",
      "pending"
    )
  })

  it("connects a signed-in runtime solidly and an unauthenticated one dashed", () => {
    const { container } = render(<ScanScene phase="found" runtimes={[SIGNED_IN, INSTALLED]} />)
    expect(screen.getByTestId("onboarding-scene-link-claude-code")).not.toHaveAttribute(
      "stroke-dasharray"
    )
    expect(screen.getByTestId("onboarding-scene-link-codex")).toHaveAttribute("stroke-dasharray")
    expect(container.querySelectorAll("path[data-tone]")).toHaveLength(2)
  })

  it("keeps the slots it looked in, so the picture shows the search not just the hits", () => {
    render(<ScanScene phase="found" runtimes={[SIGNED_IN]} />)
    // One filled, the rest still empty.
    expect(screen.getByTestId("onboarding-scene-runtime-claude-code")).toBeInTheDocument()
    for (let i = 1; i < MAX_SLOTS; i += 1) {
      expect(screen.getByTestId(`onboarding-scene-slot-${i}`)).toBeInTheDocument()
    }
  })

  it("never truncates silently — the cap covers every vendor the probe returns", () => {
    const many = Array.from({ length: MAX_SLOTS }, (_, i) => ({
      id: `rt-${i}`,
      label: `RT ${i}`,
      authenticated: false,
    }))
    render(<ScanScene phase="found" runtimes={many} />)
    for (const rt of many) {
      expect(screen.getByTestId(`onboarding-scene-runtime-${rt.id}`)).toBeInTheDocument()
    }
    expect(screen.queryByTestId("onboarding-scene-slot-0")).toBeNull()
  })

  it("breathes the empty slots only while the probe is genuinely working", () => {
    // A state, not decoration: it stops the moment the phase settles, which
    // under the soft 5s / hard 20s policy is the one real wait in the flow.
    const { rerender } = render(<ScanScene phase="scanning" runtimes={[]} />)
    expect(screen.getByTestId("onboarding-scene-slot-0")).toHaveAttribute("data-scanning", "true")

    rerender(<ScanScene phase="empty" runtimes={[]} />)
    expect(screen.getByTestId("onboarding-scene-slot-0")).toHaveAttribute("data-scanning", "false")
  })

  it("does not breathe when motion is reduced", () => {
    reduce = true
    render(<ScanScene phase="scanning" runtimes={[]} />)
    expect(screen.getByTestId("onboarding-scene-slot-0")).toHaveAttribute("data-scanning", "false")
  })

  it("carries the real transcript count, and only when there is one", () => {
    const { rerender } = render(<ScanScene phase="found" runtimes={[SIGNED_IN]} historyCount={0} />)
    expect(screen.queryByTestId("onboarding-scene-history-count")).toBeNull()

    rerender(<ScanScene phase="found" runtimes={[SIGNED_IN]} historyCount={128} />)
    expect(screen.getByText("128")).toBeInTheDocument()
  })

  it("caps an implausible count rather than overflowing the badge", () => {
    render(<ScanScene phase="found" runtimes={[SIGNED_IN]} historyCount={12345} />)
    expect(screen.getByText("999+")).toBeInTheDocument()
  })

  it("keeps the core dark until something has been found", () => {
    const { rerender } = render(<ScanScene phase="scanning" runtimes={[]} />)
    expect(screen.getByTestId("scene-core")).toHaveAttribute("data-active", "false")

    rerender(<ScanScene phase="found" runtimes={[SIGNED_IN]} />)
    expect(screen.getByTestId("scene-core")).toHaveAttribute("data-active", "true")
  })
})
