/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const skillsRef: { current: import("@/lib/claude/types").Skill[] } = { current: [] }
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => skillsRef.current,
}))
jest.mock("@/lib/db/skills", () => ({
  ...jest.requireActual("@/lib/db/skills"),
  listSkillsByIds: async () => skillsRef.current,
}))

import { fireEvent, render, screen } from "@testing-library/react"
import { SkillChipRow } from "./skill-chip-row"

beforeEach(() => {
  skillsRef.current = []
})

describe("SkillChipRow", () => {
  it("renders nothing when ids is empty", () => {
    const { container } = render(<SkillChipRow ids={[]} onRemove={jest.fn()} />)
    expect(container.firstChild).toBeNull()
  })

  it("renders a chip per skill", () => {
    skillsRef.current = [
      {
        id: "s1",
        name: "Alpha",
        content: "x",
        createdAt: 0,
        updatedAt: 0,
        source: "custom",
      } as import("@/lib/claude/types").Skill,
    ]
    render(<SkillChipRow ids={["s1"]} onRemove={jest.fn()} />)
    expect(screen.getByText("Alpha")).toBeInTheDocument()
  })

  it("calls onRemove on × click", () => {
    skillsRef.current = [
      {
        id: "s1",
        name: "Alpha",
        content: "x",
        createdAt: 0,
        updatedAt: 0,
        source: "custom",
      } as import("@/lib/claude/types").Skill,
    ]
    const onRemove = jest.fn()
    render(<SkillChipRow ids={["s1"]} onRemove={onRemove} />)
    fireEvent.click(screen.getByRole("button", { name: /removeChip.*Alpha/ }))
    expect(onRemove).toHaveBeenCalledWith("s1")
  })

  it("renders a disabled-for-session chip inert with a tooltip", () => {
    skillsRef.current = [
      {
        id: "s1",
        name: "Alpha",
        content: "x",
        createdAt: 0,
        updatedAt: 0,
        source: "custom",
      } as import("@/lib/claude/types").Skill,
    ]
    render(<SkillChipRow ids={["s1"]} onRemove={jest.fn()} disabledIds={["s1"]} />)
    const inertChip = screen.getByTitle(/inertChip/)
    expect(inertChip).toHaveClass("line-through")
    expect(screen.getByText("Alpha")).toBeInTheDocument()
  })
})
