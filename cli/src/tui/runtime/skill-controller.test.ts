/**
 * @jest-environment node
 */
import {
  buildSkillDocument,
  parseSkillFlags,
  skillCreate,
  skillDelete,
  skillDisableAll,
  skillEnableAll,
  skillFiles,
  skillList,
  skillPanel,
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

// `seedDisk` is stubbed so the default seeder (which would scan the real
// `~/.claude/skills` via `os.homedir()` and hit the live Dexie) never runs in
// unit tests. The seed-ordering test below injects its own `seedDisk`.
const base = { home: "/home", ensureDb: async () => {}, seedDisk: async () => {} }

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
  it("tags reused external skills with their origin in the hint", async () => {
    const { dispatch, actions } = recorder()
    const diskSkill = (source: string, id: string, name: string): Skill =>
      ({ id, name, content: "x", canonicalId: `cli-disk:${source}:${id}` }) as Skill
    await skillList({
      ...base,
      dispatch,
      list: async () => [
        diskSkill("claude", "cc", "CC Skill"),
        diskSkill("codex", "cdx", "Codex Skill"),
        diskSkill("opencode", "oc", "OpenCode Skill"),
        skill("local", "Local"),
      ],
      getEnabled: () => new Set(["cc", "oc"]),
    })
    expect((actions[0] as { overlay: { items: { hint: string }[] } }).overlay.items).toEqual([
      { id: "cc", label: "CC Skill", hint: "claude · on" },
      { id: "cdx", label: "Codex Skill", hint: "codex · off" },
      { id: "oc", label: "OpenCode Skill", hint: "opencode · on" },
      { id: "local", label: "Local", hint: "off" },
    ])
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

describe("skillEnableAll / skillDisableAll (全开全关)", () => {
  it("enables every discovered skill in one batch and re-opens the panel", async () => {
    const { dispatch, actions } = recorder()
    const calls: { ids: string[]; enabled: boolean }[] = []
    await skillEnableAll({
      ...base,
      dispatch,
      list: async () => [skill("s1"), skill("s2"), skill("s3")],
      setManySkillsEnabled: (ids, enabled) => calls.push({ ids, enabled }),
    })
    expect(calls).toEqual([{ ids: ["s1", "s2", "s3"], enabled: true }])
    expect((actions[0] as { message: string }).message).toContain("Enabled 3 skills")
    // Followed by a panel re-open so the new state is visible.
    expect(actions.at(-1)).toMatchObject({ type: "OVERLAY_OPEN", overlay: { kind: "skills" } })
  })

  it("disables every discovered skill", async () => {
    const { dispatch, actions } = recorder()
    const calls: { ids: string[]; enabled: boolean }[] = []
    await skillDisableAll({
      ...base,
      dispatch,
      list: async () => [skill("s1")],
      setManySkillsEnabled: (ids, enabled) => calls.push({ ids, enabled }),
    })
    expect(calls).toEqual([{ ids: ["s1"], enabled: false }])
    expect((actions[0] as { message: string }).message).toContain("Disabled 1 skill")
  })

  it("notices and does nothing when there are no skills", async () => {
    const { dispatch, actions } = recorder()
    const setMany = jest.fn()
    await skillEnableAll({ ...base, dispatch, list: async () => [], setManySkillsEnabled: setMany })
    expect(setMany).not.toHaveBeenCalled()
    expect((actions[0] as { message: string }).message).toContain("No skills")
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

describe("skillPanel", () => {
  it("opens a rich skills overlay with distilled metadata", async () => {
    const { dispatch, actions } = recorder()
    await skillPanel({
      ...base,
      dispatch,
      list: async () => [
        {
          id: "s1",
          name: "Research",
          content: "x",
          usageCount: 4,
          category: "development",
        } as Skill,
        {
          id: "s2",
          name: "Refactor",
          content: "x",
          validationErrors: [{ field: "a", message: "b" }],
        } as unknown as Skill,
      ],
      getEnabled: () => new Set(["s1"]),
    })
    const open = actions[0] as Extract<TuiAction, { type: "OVERLAY_OPEN" }>
    expect(open.overlay.kind).toBe("skills")
    const overlay = open.overlay as Extract<typeof open.overlay, { kind: "skills" }>
    expect(overlay.rows.find((r) => r.id === "s1")).toMatchObject({ enabled: true, usageCount: 4 })
    expect(overlay.rows.find((r) => r.id === "s2")).toMatchObject({ enabled: false, errorCount: 1 })
  })

  it("notices when there are no skills", async () => {
    const { dispatch, actions } = recorder()
    await skillPanel({ ...base, dispatch, list: async () => [], getEnabled: () => new Set() })
    expect(actions[0]).toMatchObject({ type: "NOTICE" })
  })
})

describe("skillCreate", () => {
  it("creates a skill from --name/--description and re-opens the panel", async () => {
    const { dispatch, actions } = recorder()
    const created: Array<{ name: string; description?: string }> = []
    await skillCreate("--name My Skill --description does things", {
      ...base,
      dispatch,
      create: async (draft) => {
        created.push(draft)
        return { id: "new1", name: draft.name } as Skill
      },
      list: async () => [{ id: "new1", name: "My Skill", content: "x" } as Skill],
      getEnabled: () => new Set(),
    })
    expect(created[0]).toMatchObject({ name: "My Skill", description: "does things" })
    expect(
      actions.some(
        (a) => a.type === "NOTICE" && /Created skill/.test((a as { message: string }).message)
      )
    ).toBe(true)
    // Panel re-opened afterwards.
    expect(actions.some((a) => a.type === "OVERLAY_OPEN")).toBe(true)
  })

  it("requires a name", async () => {
    const { dispatch, actions } = recorder()
    await skillCreate("", { ...base, dispatch, create: async () => ({}) as Skill })
    expect((actions[0] as { message: string }).message).toContain("Usage")
  })
})

describe("skillDelete", () => {
  it("deletes a custom (non-disk, non-builtin) skill and re-opens the panel", async () => {
    const { dispatch, actions } = recorder()
    const removed: string[] = []
    await skillDelete("c1", {
      ...base,
      dispatch,
      get: async () => ({ id: "c1", name: "Custom", content: "x" }) as Skill,
      remove: async (id) => {
        removed.push(id)
      },
      setSkillEnabled: () => {},
      list: async () => [],
      getEnabled: () => new Set(),
    })
    expect(removed).toEqual(["c1"])
    expect(
      actions.some((a) => a.type === "NOTICE" && /Deleted/.test((a as { message: string }).message))
    ).toBe(true)
  })

  it("refuses to delete a built-in skill", async () => {
    const { dispatch, actions } = recorder()
    await skillDelete("b1", {
      ...base,
      dispatch,
      get: async () => ({ id: "b1", name: "Builtin", content: "x", isBuiltIn: true }) as Skill,
      remove: async () => {
        throw new Error("should not be called")
      },
    })
    expect((actions[0] as { message: string }).message).toContain("built-in")
  })

  it("refuses to delete an on-disk skill (it would re-seed)", async () => {
    const { dispatch, actions } = recorder()
    await skillDelete("d1", {
      ...base,
      dispatch,
      get: async () =>
        ({ id: "d1", name: "Disk", content: "x", canonicalId: "cli-disk:project:d1" }) as Skill,
      remove: async () => {
        throw new Error("should not be called")
      },
    })
    expect((actions[0] as { message: string }).message).toContain("on-disk")
  })
})

describe("parseSkillFlags", () => {
  it("parses multi-token values", () => {
    expect(parseSkillFlags("--name My Skill --description a b c")).toEqual({
      name: "My Skill",
      description: "a b c",
    })
  })
})
