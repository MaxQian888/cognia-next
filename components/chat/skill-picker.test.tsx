/**
 * @jest-environment jsdom
 */

// next-intl is globally mocked in jest.setup.ts (key-resolving translator backed by
// i18n/messages/en.json). Inline override removed — this suite asserts on fixture skill
// names, not translation strings.

const skillsRef: { current: import("@cognia/agent-config-types").Skill[] } = { current: [] }
// Invoke the querier so the open-gating (listSkills vs Promise.resolve([])) is
// actually exercised, then return the staged rows for rendering.
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (fn: () => unknown) => {
    void fn()
    return skillsRef.current
  },
}))
const listSkillsMock = jest.fn(async () => skillsRef.current)
jest.mock("@/lib/db/skills", () => ({
  listSkills: () => listSkillsMock(),
}))

import { fireEvent, render, screen } from "@testing-library/react"
import { SkillPicker } from "./skill-picker"

beforeEach(() => {
  skillsRef.current = []
  listSkillsMock.mockClear()
})

function makeSkill(over: Partial<import("@cognia/agent-config-types").Skill>) {
  return {
    id: "s1",
    name: "Alpha",
    content: "x",
    createdAt: 0,
    updatedAt: 0,
    source: "custom",
    ...over,
  } as import("@cognia/agent-config-types").Skill
}

describe("SkillPicker", () => {
  it("splits custom + built-in groups and excludes disabled skills", () => {
    skillsRef.current = [
      makeSkill({ id: "s1", name: "Alpha" }),
      makeSkill({ id: "s2", name: "Beta", status: "disabled" }),
      makeSkill({ id: "s3", name: "Built", isBuiltIn: true }),
    ]
    render(<SkillPicker open={true} onOpenChange={jest.fn()} value={[]} onChange={jest.fn()} />)
    expect(screen.getByText("Alpha")).toBeInTheDocument()
    // Built-in skills are now attachable, under their own group heading.
    expect(screen.getByText("Built")).toBeInTheDocument()
    expect(screen.getByText("Built-in skills")).toBeInTheDocument()
    // Disabled skill stays hidden.
    expect(screen.queryByText("Beta")).not.toBeInTheDocument()
  })

  it("toggles a custom skill selection on click", () => {
    skillsRef.current = [makeSkill({ id: "s1", name: "Alpha" })]
    const onChange = jest.fn()
    render(<SkillPicker open={true} onOpenChange={jest.fn()} value={[]} onChange={onChange} />)
    fireEvent.click(screen.getByText("Alpha"))
    expect(onChange).toHaveBeenCalledWith(["s1"])
  })

  it("allows attaching a built-in skill", () => {
    skillsRef.current = [makeSkill({ id: "s3", name: "Built", isBuiltIn: true })]
    const onChange = jest.fn()
    render(<SkillPicker open={true} onOpenChange={jest.fn()} value={[]} onChange={onChange} />)
    fireEvent.click(screen.getByText("Built"))
    expect(onChange).toHaveBeenCalledWith(["s3"])
  })

  it("deselects an already-attached skill (toggle off)", () => {
    skillsRef.current = [makeSkill({ id: "s1", name: "Alpha" })]
    const onChange = jest.fn()
    render(<SkillPicker open={true} onOpenChange={jest.fn()} value={["s1"]} onChange={onChange} />)
    fireEvent.click(screen.getByText("Alpha"))
    expect(onChange).toHaveBeenCalledWith([])
  })

  it("does not query the skills table while closed", () => {
    render(<SkillPicker open={false} onOpenChange={jest.fn()} value={[]} onChange={jest.fn()} />)
    expect(listSkillsMock).not.toHaveBeenCalled()
    render(<SkillPicker open={true} onOpenChange={jest.fn()} value={[]} onChange={jest.fn()} />)
    expect(listSkillsMock).toHaveBeenCalled()
  })
})
