/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import { SkillsSection } from "./skills-section"

// Stub SkillPanel — its own coverage lives in components/skills/. The
// wrapper's responsibility is layout + container metadata.
jest.mock("@/components/skills", () => ({
  SkillPanel: () => <div data-testid="stub-skill-panel">panel</div>,
}))

describe("SkillsSection", () => {
  it("mounts SkillPanel inside a fill-height flex container", () => {
    render(<SkillsSection />)
    const root = screen.getByTestId("skills-section")
    expect(root).toBeInTheDocument()
    expect(screen.getByTestId("stub-skill-panel")).toBeInTheDocument()
    // The panel fills its parent (the shell's fill-height branch) rather than
    // guessing a viewport-relative height, so it adapts to the actual pane.
    expect(root.className).toMatch(/\bflex-1\b/)
    expect(root.className).toMatch(/\bmin-h-0\b/)
    expect(root.className).toMatch(/\bh-full\b/)
    // The old magic `100dvh - 8rem` calc and padding-cancelling negative
    // margins are gone — the shell now supplies bounds and padding.
    expect(root.className).not.toMatch(/h-\[calc\(100dvh/)
    expect(root.className).not.toMatch(/-mx-3/)
  })

  it("merges an extra className from the parent", () => {
    render(<SkillsSection className="custom-foo" />)
    expect(screen.getByTestId("skills-section").className).toMatch(/custom-foo/)
  })
})
