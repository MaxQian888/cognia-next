/**
 * @jest-environment jsdom
 */

// next-intl is globally mocked in jest.setup.ts (key-resolving translator backed by
// i18n/messages/en.json). Inline override removed — this suite asserts on fixture skill
// names, not translation strings.

const skillsRef: { current: import("@/lib/claude/types").Skill[] } = { current: [] }
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => skillsRef.current,
}))
jest.mock("@/lib/db/skills", () => ({
  listSkills: async () => skillsRef.current,
}))

import { fireEvent, render, screen } from "@testing-library/react"
import { SkillPicker } from "./skill-picker"

beforeEach(() => {
  skillsRef.current = []
})

function makeSkill(over: Partial<import("@/lib/claude/types").Skill>) {
  return {
    id: "s1",
    name: "Alpha",
    content: "x",
    createdAt: 0,
    updatedAt: 0,
    source: "custom",
    ...over,
  } as import("@/lib/claude/types").Skill
}

describe("SkillPicker", () => {
  it("lists enabled non-builtin skills only", () => {
    skillsRef.current = [
      makeSkill({ id: "s1", name: "Alpha" }),
      makeSkill({ id: "s2", name: "Beta", status: "disabled" }),
      makeSkill({ id: "s3", name: "Built", isBuiltIn: true }),
    ]
    render(<SkillPicker open={true} onOpenChange={jest.fn()} value={[]} onChange={jest.fn()} />)
    expect(screen.getByText("Alpha")).toBeInTheDocument()
    expect(screen.queryByText("Beta")).not.toBeInTheDocument()
    expect(screen.queryByText("Built")).not.toBeInTheDocument()
  })

  it("toggles selection on click", () => {
    skillsRef.current = [makeSkill({ id: "s1", name: "Alpha" })]
    const onChange = jest.fn()
    render(<SkillPicker open={true} onOpenChange={jest.fn()} value={[]} onChange={onChange} />)
    fireEvent.click(screen.getByText("Alpha"))
    expect(onChange).toHaveBeenCalledWith(["s1"])
  })
})
