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
  it("mounts SkillPanel inside a fixed-height settings container", () => {
    render(<SkillsSection />)
    const root = screen.getByTestId("skills-section")
    expect(root).toBeInTheDocument()
    expect(screen.getByTestId("stub-skill-panel")).toBeInTheDocument()
    // Container must include a vh-relative height so the panel doesn't
    // collapse inside the settings ScrollArea.
    expect(root.className).toMatch(/h-\[calc\(100dvh/)
    // Negative margins peel the panel out of the shell's section padding.
    expect(root.className).toMatch(/-mx-3/)
  })

  it("merges an extra className from the parent", () => {
    render(<SkillsSection className="custom-foo" />)
    expect(screen.getByTestId("skills-section").className).toMatch(/custom-foo/)
  })
})
