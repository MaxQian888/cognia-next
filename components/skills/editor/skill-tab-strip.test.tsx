/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

import { fireEvent, render, screen } from "@testing-library/react"
import { SkillTabStrip } from "./skill-tab-strip"
import type { EditorFile } from "@/stores/skills/skills-store"

const files: EditorFile[] = [
  {
    id: "main",
    kind: "main",
    path: "SKILL.md",
    language: "markdown",
    draftContent: "a",
    savedContent: "a",
  },
  {
    id: "r1",
    kind: "resource",
    resourceId: "r1",
    path: "scripts/x.sh",
    language: "shell",
    draftContent: "echo",
    savedContent: "echo",
  },
]

describe("SkillTabStrip", () => {
  it("renders one tab per file", () => {
    render(
      <SkillTabStrip files={files} activeFileId="main" onSelect={jest.fn()} onClose={jest.fn()} />
    )
    expect(screen.getByRole("tab", { name: "SKILL.md" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "scripts/x.sh" })).toBeInTheDocument()
  })

  it("shows a dirty marker when draftContent differs from savedContent", () => {
    const dirtyFiles = [{ ...files[0], draftContent: "edited" }, files[1]]
    render(
      <SkillTabStrip
        files={dirtyFiles}
        activeFileId="main"
        onSelect={jest.fn()}
        onClose={jest.fn()}
      />
    )
    expect(screen.getByTestId("dirty-main")).toBeInTheDocument()
  })

  it("calls onSelect on tab click", () => {
    const onSelect = jest.fn()
    render(
      <SkillTabStrip files={files} activeFileId="main" onSelect={onSelect} onClose={jest.fn()} />
    )
    fireEvent.click(screen.getByRole("tab", { name: "scripts/x.sh" }))
    expect(onSelect).toHaveBeenCalledWith("r1")
  })

  it("calls onClose with dirty=false on close click of a clean tab", () => {
    const onClose = jest.fn()
    render(
      <SkillTabStrip files={files} activeFileId="main" onSelect={jest.fn()} onClose={onClose} />
    )
    fireEvent.click(screen.getByRole("button", { name: /closeTab.*SKILL\.md/ }))
    expect(onClose).toHaveBeenCalledWith("main", false)
  })
})
