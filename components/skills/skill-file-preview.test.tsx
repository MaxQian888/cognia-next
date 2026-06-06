/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

import { fireEvent, render, screen } from "@testing-library/react"
import { SkillFilePreview } from "./skill-file-preview"
import type { SkillsShFileTreeNode } from "@/lib/skills/skillssh-install"

const FILES: SkillsShFileTreeNode[] = [
  { path: "SKILL.md", kind: "skill", size: 100 },
  { path: "scripts/run.sh", kind: "script", size: 2048 },
  { path: "assets/logo.png", kind: "asset", size: 5 },
]

describe("SkillFilePreview", () => {
  it("shows loading for 'loading' and undefined", () => {
    const { rerender } = render(<SkillFilePreview files="loading" />)
    expect(screen.getByText("loading")).toBeInTheDocument()
    rerender(<SkillFilePreview files={undefined} />)
    expect(screen.getByText("loading")).toBeInTheDocument()
  })

  it("shows the empty message for an empty manifest", () => {
    render(<SkillFilePreview files={[]} />)
    expect(screen.getByText("empty")).toBeInTheDocument()
  })

  it("toggles the collapsible file list and renders sizes", () => {
    render(<SkillFilePreview files={FILES} />)
    const trigger = screen.getByTestId("skill-file-preview-trigger")
    expect(trigger).toHaveTextContent('title:{"count":3}')
    expect(screen.queryByTestId("skill-file-preview-list")).not.toBeInTheDocument()
    fireEvent.click(trigger)
    const list = screen.getByTestId("skill-file-preview-list")
    expect(list).toBeInTheDocument()
    expect(screen.getByText("SKILL.md")).toBeInTheDocument()
    expect(screen.getByText("scripts/run.sh")).toBeInTheDocument()
    expect(screen.getByText("100 B")).toBeInTheDocument()
    expect(screen.getByText("2.0 KB")).toBeInTheDocument()
  })
})
