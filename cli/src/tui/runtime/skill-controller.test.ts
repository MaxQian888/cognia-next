/**
 * @jest-environment node
 */
import {
  buildSkillDocument,
  skillFiles,
  skillList,
  skillSetEnabled,
  skillShow,
  skillToggle,
} from "./skill-controller"
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

describe("buildSkillDocument", () => {
  it("renders metadata header + body as markdown", () => {
    const doc = buildSkillDocument(
      {
        id: "research",
        name: "Research",
        content: "Do the research.",
        description: "Deep research helper",
        source: "imported",
        allowedTools: ["WebSearch", "Read"],
        canonicalId: "cli-disk:project:research",
      } as Skill,
      true
    )
    expect(doc).toContain("# Research")
    expect(doc).toContain("`research`")
    expect(doc).toContain("enabled")
    expect(doc).toContain("> Deep research helper")
    expect(doc).toContain("**Allowed tools:** WebSearch, Read")
    expect(doc).toContain("/skill files research")
    expect(doc).toContain("Do the research.")
  })

  it("omits the bundled-files hint for non-disk skills and shows empty body", () => {
    const doc = buildSkillDocument({ id: "b", name: "Builtin", content: "  " } as Skill, false)
    expect(doc).not.toContain("/skill files")
    expect(doc).toContain("disabled")
    expect(doc).toContain("_(empty body)_")
  })
})

describe("skillShow", () => {
  it("opens a markdown document with the skill detail", async () => {
    const { dispatch, actions } = recorder()
    await skillShow("s1", {
      ...base,
      dispatch,
      get: async () => skill("s1", "Research"),
      getEnabled: () => new Set(["s1"]),
    })
    expect(actions[0]).toMatchObject({
      type: "OVERLAY_OPEN",
      overlay: { kind: "document", format: "markdown", title: "Skill · Research" },
    })
    expect((actions[0] as { overlay: { body: string } }).overlay.body).toContain("body of Research")
  })
  it("notices a missing skill", async () => {
    const { dispatch, actions } = recorder()
    await skillShow("x", { ...base, dispatch, get: async () => undefined })
    expect((actions[0] as { message: string }).message).toContain("not found")
  })
})

describe("skillFiles", () => {
  const diskSkill = (id: string): Skill =>
    ({ id, name: id, content: "x", canonicalId: `cli-disk:project:${id}` }) as Skill

  it("opens a select overlay of bundled files chaining into /view", async () => {
    const { dispatch, actions } = recorder()
    await skillFiles("d1", {
      ...base,
      cwd: "/work",
      dispatch,
      get: async () => diskSkill("d1"),
      findDisk: async () => ({ dir: "/work/.cognia/skills/d1" }),
      listFiles: async () => [
        { relPath: "SKILL.md", absPath: "/work/.cognia/skills/d1/SKILL.md" },
        { relPath: "ref/x.md", absPath: "/work/.cognia/skills/d1/ref/x.md" },
      ],
    })
    expect(actions[0]).toMatchObject({
      type: "OVERLAY_OPEN",
      overlay: {
        kind: "select",
        onSelectCommand: "view",
        items: [
          { id: "/work/.cognia/skills/d1/SKILL.md", label: "SKILL.md" },
          { id: "/work/.cognia/skills/d1/ref/x.md", label: "ref/x.md" },
        ],
      },
    })
  })

  it("notices when the skill is not an on-disk skill", async () => {
    const { dispatch, actions } = recorder()
    await skillFiles("b", {
      ...base,
      cwd: "/work",
      dispatch,
      get: async () => skill("b", "Builtin"),
    })
    expect((actions[0] as { message: string }).message).toContain("no bundled files")
  })

  it("notices a missing skill", async () => {
    const { dispatch, actions } = recorder()
    await skillFiles("x", { ...base, cwd: "/work", dispatch, get: async () => undefined })
    expect((actions[0] as { message: string }).message).toContain("not found")
  })

  it("notices when a disk skill bundles no files", async () => {
    const { dispatch, actions } = recorder()
    await skillFiles("d1", {
      ...base,
      cwd: "/work",
      dispatch,
      get: async () => diskSkill("d1"),
      findDisk: async () => ({ dir: "/work/.cognia/skills/d1" }),
      listFiles: async () => [],
    })
    expect((actions[0] as { message: string }).message).toContain("bundles no files")
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
