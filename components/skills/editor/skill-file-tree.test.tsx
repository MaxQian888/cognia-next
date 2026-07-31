/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { fireEvent, render, screen } from "@testing-library/react"
import { SkillFileTree } from "./skill-file-tree"
import type { Skill, SkillResource } from "@cognia/agent-config-types"

const skill = { id: "s1", name: "X" } as Skill
const resources: SkillResource[] = [
  {
    id: "r1",
    skillId: "s1",
    kind: "script",
    name: "build.sh",
    path: "scripts/build.sh",
    content: "",
    encoding: "utf-8",
    size: 0,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "r2",
    skillId: "s1",
    kind: "reference",
    name: "api.md",
    path: "references/api.md",
    content: "",
    encoding: "utf-8",
    size: 0,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "r3",
    skillId: "s1",
    kind: "asset",
    name: "logo.png",
    path: "assets/logo.png",
    content: "",
    encoding: "base64",
    size: 0,
    createdAt: 0,
    updatedAt: 0,
  },
]

describe("SkillFileTree", () => {
  it("renders the SKILL.md root and groups by kind", () => {
    render(
      <SkillFileTree skill={skill} resources={resources} activeFileId={null} onSelect={jest.fn()} />
    )
    expect(screen.getByText("SKILL.md")).toBeInTheDocument()
    expect(screen.getByText("scripts/")).toBeInTheDocument()
    expect(screen.getByText("references/")).toBeInTheDocument()
    expect(screen.getByText("assets/")).toBeInTheDocument()
    expect(screen.getByText("build.sh")).toBeInTheDocument()
    expect(screen.getByText("api.md")).toBeInTheDocument()
    expect(screen.getByText("logo.png")).toBeInTheDocument()
  })

  it("calls onSelect with main on SKILL.md click", () => {
    const onSelect = jest.fn()
    render(
      <SkillFileTree skill={skill} resources={resources} activeFileId={null} onSelect={onSelect} />
    )
    fireEvent.click(screen.getByText("SKILL.md"))
    expect(onSelect).toHaveBeenCalledWith({ id: "main", kind: "main" })
  })

  it("calls onSelect with resource info on resource click", () => {
    const onSelect = jest.fn()
    render(
      <SkillFileTree skill={skill} resources={resources} activeFileId={null} onSelect={onSelect} />
    )
    fireEvent.click(screen.getByText("build.sh"))
    expect(onSelect).toHaveBeenCalledWith({
      id: "r1",
      kind: "resource",
      resource: resources[0],
    })
  })

  it("uses the localized fileTreeAria label", () => {
    render(
      <SkillFileTree skill={skill} resources={resources} activeFileId={null} onSelect={jest.fn()} />
    )
    // next-intl mock echoes the key; the literal "Skill files" should no longer appear.
    expect(screen.getByRole("navigation", { name: "fileTreeAria" })).toBeInTheDocument()
  })
})
