/**
 * @jest-environment jsdom
 */

// next-intl is globally mocked in jest.setup.ts (key-resolving translator backed by
// i18n/messages/en.json). Inline override removed — this suite asserts on fixture skill
// names, not translation strings.

// `undefined` = the live query has not resolved yet (the `isLoading` branch);
// an empty array = resolved to nothing (the `CommandEmpty` branch).
const skillsRef: { current: import("@cognia/agent-config-types").Skill[] | undefined } = {
  current: [],
}
// Invoke the querier so the active-gating (listSkills vs Promise.resolve([])) is
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
import { Command } from "@/components/ui/command"
import { SkillPickerContent, SkillPickerPanel } from "./skill-picker"

function renderPicker(active: boolean, value: string[] = [], onChange = jest.fn()) {
  return render(
    <Command>
      <SkillPickerContent active={active} value={value} onChange={onChange} />
    </Command>
  )
}

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

describe("SkillPickerContent", () => {
  it("splits custom + built-in groups and excludes disabled skills", () => {
    skillsRef.current = [
      makeSkill({ id: "s1", name: "Alpha" }),
      makeSkill({ id: "s2", name: "Beta", status: "disabled" }),
      makeSkill({ id: "s3", name: "Built", isBuiltIn: true }),
    ]
    renderPicker(true)
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
    renderPicker(true, [], onChange)
    fireEvent.click(screen.getByText("Alpha"))
    expect(onChange).toHaveBeenCalledWith(["s1"])
  })

  it("allows attaching a built-in skill", () => {
    skillsRef.current = [makeSkill({ id: "s3", name: "Built", isBuiltIn: true })]
    const onChange = jest.fn()
    renderPicker(true, [], onChange)
    fireEvent.click(screen.getByText("Built"))
    expect(onChange).toHaveBeenCalledWith(["s3"])
  })

  it("deselects an already-attached skill (toggle off)", () => {
    skillsRef.current = [makeSkill({ id: "s1", name: "Alpha" })]
    const onChange = jest.fn()
    renderPicker(true, ["s1"], onChange)
    fireEvent.click(screen.getByText("Alpha"))
    expect(onChange).toHaveBeenCalledWith([])
  })

  it("suppresses the empty state while the skills table read is in flight", () => {
    skillsRef.current = undefined
    renderPicker(true)
    // Unresolved is "not yet", not "none" — the empty copy must not flash.
    expect(screen.queryByText("No skills found.")).not.toBeInTheDocument()
  })

  it("does not query the skills table while its host is closed", () => {
    renderPicker(false)
    expect(listSkillsMock).not.toHaveBeenCalled()
    renderPicker(true)
    expect(listSkillsMock).toHaveBeenCalled()
  })
})

describe("SkillPickerContent — plugin skills", () => {
  const { registerSkill, unregisterSkillsByPlugin } = jest.requireActual<
    typeof import("@/lib/plugin/registries/skill-registry")
  >("@/lib/plugin/registries/skill-registry")

  afterEach(() => {
    unregisterSkillsByPlugin("acme")
  })

  it("lists skills contributed by enabled plugins and toggles their registry id", () => {
    registerSkill(
      "acme:review",
      {
        id: "acme:review",
        name: "Acme review",
        description: "Reviews a diff",
        source: { kind: "inline", markdown: "# review" },
      },
      { pluginId: "acme" }
    )
    const onChange = jest.fn()
    renderPicker(true, [], onChange)
    fireEvent.click(screen.getByText("Acme review"))
    expect(onChange).toHaveBeenCalledWith(["acme:review"])
  })

  it("does not offer a character-only plugin skill in the composer", () => {
    registerSkill(
      "acme:persona",
      {
        id: "acme:persona",
        name: "Persona only",
        description: "",
        scope: "character",
        source: { kind: "inline", markdown: "# persona" },
      },
      { pluginId: "acme" }
    )
    renderPicker(true)
    expect(screen.queryByText("Persona only")).toBeNull()
  })
})

describe("SkillPickerPanel (the mobile sheet's drilled-in list)", () => {
  function renderPanel(value: string[] = [], onChange = jest.fn()) {
    return render(<SkillPickerPanel active value={value} onChange={onChange} />)
  }

  it("offers the search field without focusing it, so the keyboard stays down", () => {
    skillsRef.current = [makeSkill({ id: "s1", name: "Alpha" })]
    renderPanel()
    const search = screen.getByPlaceholderText("Search skills…")
    expect(search).not.toHaveFocus()
    expect(search).not.toHaveAttribute("autofocus")
    // 16px, so iOS does not zoom the page when the user does tap in.
    expect(search.className).toContain("text-base")
  })

  it("draws thumb-sized rows with no resting highlight on the first match", () => {
    skillsRef.current = [
      makeSkill({ id: "s1", name: "Alpha" }),
      makeSkill({ id: "s3", name: "Built", isBuiltIn: true }),
    ]
    renderPanel()
    const row = screen.getByText("Alpha").closest("[cmdk-item]")!
    expect(row.className).toContain("touch-target")
    // cmdk's keyboard target is only painted while the search field has focus.
    expect(row.className).toContain("data-[selected=true]:bg-transparent")
    expect(row.className).toContain(
      "group-focus-within/skill-sheet:data-[selected=true]:bg-accent!"
    )
  })

  it("sizes itself so the list scrolls inside the sheet", () => {
    skillsRef.current = [makeSkill({ id: "s1", name: "Alpha" })]
    renderPanel()
    expect(screen.getByTestId("skill-picker-panel").className).toContain("h-[min(26rem,60dvh)]")
    const list = document.querySelector("[cmdk-list]")!
    expect(list.className).toContain("flex-1")
    expect(list.className).not.toContain("max-h-[300px]")
  })

  it("marks the picked skills and toggles like the flyout does", () => {
    skillsRef.current = [
      makeSkill({ id: "s1", name: "Alpha" }),
      makeSkill({ id: "s2", name: "Gamma" }),
    ]
    const onChange = jest.fn()
    renderPanel(["s1"], onChange)
    expect(screen.getByText("Alpha").closest("[cmdk-item]")).toHaveAttribute("data-picked", "true")
    expect(screen.getByText("Gamma").closest("[cmdk-item]")).not.toHaveAttribute("data-picked")
    fireEvent.click(screen.getByText("Gamma"))
    expect(onChange).toHaveBeenCalledWith(["s1", "s2"])
  })

  it("leaves the desktop flyout's dense rows alone", () => {
    skillsRef.current = [makeSkill({ id: "s1", name: "Alpha" })]
    renderPicker(true)
    expect(screen.getByText("Alpha").closest("[cmdk-item]")!.className).not.toContain(
      "touch-target"
    )
  })
})
