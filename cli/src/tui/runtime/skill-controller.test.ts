/**
 * @jest-environment node
 */
import { skillList, skillSetEnabled, skillShow, skillToggle } from "./skill-controller"
import type { Skill } from "@/lib/claude/types"
import type { TuiAction } from "../state/types"

function recorder() {
  const actions: TuiAction[] = []
  return { dispatch: (a: TuiAction) => actions.push(a), actions }
}

const skill = (id: string, name = id): Skill => ({ id, name, content: `body of ${name}` }) as Skill

const base = { home: "/home", ensureDb: async () => {} }

describe("skillList", () => {
  it("opens a select overlay with per-session enabled badges", async () => {
    const { dispatch, actions } = recorder()
    await skillList({
      ...base,
      dispatch,
      list: async () => [skill("s1", "Research"), skill("s2", "Refactor")],
      getEnabled: () => new Set(["s1"]),
    })
    expect(actions[0]).toMatchObject({
      type: "OVERLAY_OPEN",
      overlay: {
        kind: "select",
        onSelectCommand: "skill toggle",
        items: [
          { id: "s1", label: "Research", hint: "on" },
          { id: "s2", label: "Refactor", hint: "off" },
        ],
      },
    })
  })
  it("notices when none exist", async () => {
    const { dispatch, actions } = recorder()
    await skillList({ ...base, dispatch, list: async () => [] })
    expect((actions[0] as { message: string }).message).toContain("No skills")
  })
  it("imports disk SKILL.md skills before listing", async () => {
    const { dispatch } = recorder()
    const order: string[] = []
    await skillList({
      ...base,
      dispatch,
      seedDisk: async () => {
        order.push("seed")
      },
      list: async () => {
        order.push("list")
        return [skill("d1", "Disk Skill")]
      },
    })
    // Disk skills are imported into Dexie BEFORE the list reads it.
    expect(order).toEqual(["seed", "list"])
  })
})

describe("skillShow", () => {
  it("notices the skill name + content", async () => {
    const { dispatch, actions } = recorder()
    await skillShow("s1", { ...base, dispatch, get: async () => skill("s1", "Research") })
    expect((actions[0] as { message: string }).message).toContain("body of Research")
  })
  it("notices a missing skill", async () => {
    const { dispatch, actions } = recorder()
    await skillShow("x", { ...base, dispatch, get: async () => undefined })
    expect((actions[0] as { message: string }).message).toContain("not found")
  })
})

describe("skillToggle", () => {
  it("turns an off skill on", async () => {
    const { dispatch, actions } = recorder()
    let captured: { id: string; on: boolean } | null = null
    await skillToggle("s1", {
      ...base,
      dispatch,
      getEnabled: () => new Set(),
      setSkillEnabled: (id, on) => {
        captured = { id, on }
      },
    })
    expect(captured).toEqual({ id: "s1", on: true })
    expect((actions[0] as { message: string }).message).toContain("enabled")
  })
})

describe("skillSetEnabled", () => {
  it("passes the explicit enabled flag through", () => {
    let captured: { id: string; on: boolean } | null = null
    skillSetEnabled("s1", false, {
      ...base,
      dispatch: () => {},
      setSkillEnabled: (id, on) => {
        captured = { id, on }
      },
    })
    expect(captured).toEqual({ id: "s1", on: false })
  })
})
