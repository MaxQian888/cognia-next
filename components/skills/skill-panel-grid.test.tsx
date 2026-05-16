/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

jest.mock("@/lib/tauri", () => ({
  isTauri: () => false,
}))

jest.mock("@/lib/db/skills", () => ({
  duplicateSkill: jest.fn(async (id: string) => ({ id: `${id}-dup`, name: "DupCopy" })),
  setSkillStatus: jest.fn(),
  // SkillCard reads these synchronously to compute badge metadata.
  inferCategory: (s: { category?: string }) => s.category ?? "custom",
  inferSource: (s: { source?: string }) => s.source ?? "custom",
}))

jest.mock("@/lib/files/file-bridge", () => ({
  saveFileAs: jest.fn(async () => false),
}))

jest.mock("@/lib/claude/skills-io", () => ({
  serializeSkill: () => "",
  skillFilename: (name: string) => `${name}.md`,
}))

import { render, screen } from "@testing-library/react"
import { useSkillsStore } from "@/stores/skills"
import { SkillPanelGrid } from "./skill-panel-grid"
import type { Skill } from "@/lib/claude/types"

const mkSkill = (id: string, name: string): Skill =>
  ({
    id,
    name,
    description: "x",
    content: "x",
    source: "custom",
    status: "enabled",
    createdAt: 0,
    updatedAt: 0,
  }) as Skill

beforeEach(() => {
  useSkillsStore.setState({
    selection: new Set<string>(),
    activeTab: "my-skills",
  } as never)
})

describe("SkillPanelGrid", () => {
  it("renders the empty state when there are no skills", () => {
    render(<SkillPanelGrid skills={[]} />)
    expect(screen.getByText("panel.emptyTitle")).toBeInTheDocument()
    expect(screen.getByText("panel.emptyHint")).toBeInTheDocument()
    expect(screen.getByText("panel.emptyAction")).toBeInTheDocument()
  })

  it("renders one card per skill inside the stagger container", () => {
    render(<SkillPanelGrid skills={[mkSkill("a", "Alpha"), mkSkill("b", "Beta")]} />)
    const grid = screen.getByTestId("skill-panel-grid")
    expect(grid).toBeInTheDocument()
    expect(screen.getByText("Alpha")).toBeInTheDocument()
    expect(screen.getByText("Beta")).toBeInTheDocument()
  })
})
