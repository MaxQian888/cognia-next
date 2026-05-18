/**
 * @jest-environment jsdom
 */

// The page is a 9-line shell over `SkillPanel`. We mock the panel so the
// test stays at the route layer — verifying the wrapper element, the
// `data-bg-target` attribute (consumed by the chat background renderer),
// and that the panel mounts.

jest.mock("@/components/skills", () => ({
  SkillPanel: () => <div data-testid="skill-panel-stub" />,
}))

import { render, screen } from "@testing-library/react"
import SkillsRoutePage from "./page"

describe("SkillsRoutePage", () => {
  it("renders the SkillPanel inside the chat-background wrapper", () => {
    const { container } = render(<SkillsRoutePage />)
    expect(screen.getByTestId("skill-panel-stub")).toBeInTheDocument()
    const wrapper = container.querySelector("[data-bg-target='chat']")
    expect(wrapper).not.toBeNull()
    expect(wrapper?.className).toContain("h-full")
    expect(wrapper?.className).toContain("w-full")
  })
})
