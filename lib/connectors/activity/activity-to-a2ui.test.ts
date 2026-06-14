import { buildActivitySurface } from "./activity-to-a2ui"
import { resolveActivityI18n } from "./i18n"
import type { TurnActivitySnapshot } from "./turn-activity-tracker"

const i18n = resolveActivityI18n("en")

function root(s: A2UIish): { component: string; title: string; children: string[] } {
  return s.components.root as { component: string; title: string; children: string[] }
}

interface A2UIish {
  components: Record<string, unknown>
  dataModel: Record<string, unknown>
  rootId: string
  surfaceType?: string
  title: string
  widget?: Record<string, unknown>
}

describe("buildActivitySurface", () => {
  it("running snapshot produces a Card titled with counts + elapsed", () => {
    const snap: TurnActivitySnapshot = {
      status: "running",
      elapsedMs: 45000,
      toolCount: 3,
      editCount: 1,
      currentTool: "bash",
      turnStartedAt: 0,
      edits: [],
    }
    const s = buildActivitySurface(snap, i18n) as A2UIish
    const r = root(s)
    expect(r.component).toBe("Card")
    expect(r.title).toBe("🔧 3 tools · 1 edit · 45s")
    expect(s.surfaceType).toBe("inline")
    expect(s.rootId).toBe("root")
  })

  it("running snapshot with a current tool adds a Text child line", () => {
    const snap: TurnActivitySnapshot = {
      status: "running",
      elapsedMs: 1000,
      toolCount: 1,
      editCount: 0,
      currentTool: "bash",
      turnStartedAt: 0,
      edits: [],
    }
    const s = buildActivitySurface(snap, i18n) as A2UIish
    const r = root(s)
    expect(r.children).toContain("currentTool")
    const cur = s.components.currentTool as { component: string; text: string }
    expect(cur.component).toBe("Text")
    expect(cur.text).toBe("Current: bash")
  })

  it("running snapshot with no current tool omits the current-tool line", () => {
    const snap: TurnActivitySnapshot = {
      status: "running",
      elapsedMs: 0,
      toolCount: 0,
      editCount: 0,
      currentTool: null,
      turnStartedAt: 0,
      edits: [],
    }
    const s = buildActivitySurface(snap, i18n) as A2UIish
    expect(root(s).children).not.toContain("currentTool")
  })

  it("done snapshot title uses the done verb + elapsed", () => {
    const snap: TurnActivitySnapshot = {
      status: "done",
      elapsedMs: 12000,
      toolCount: 4,
      editCount: 2,
      currentTool: null,
      turnStartedAt: 0,
      edits: [],
    }
    const s = buildActivitySurface(snap, i18n) as A2UIish
    expect(root(s).title).toBe("✓ Done · 12s")
  })

  it("failed snapshot title uses the failed verb", () => {
    const snap: TurnActivitySnapshot = {
      status: "failed",
      elapsedMs: 3000,
      toolCount: 1,
      editCount: 0,
      currentTool: null,
      turnStartedAt: 0,
      edits: [],
    }
    const s = buildActivitySurface(snap, i18n) as A2UIish
    expect(root(s).title).toBe("✗ Failed · 3s")
  })

  it("terminal snapshot renders each edit as a Collapsible with a diff body", () => {
    const snap: TurnActivitySnapshot = {
      status: "done",
      elapsedMs: 5000,
      toolCount: 2,
      editCount: 1,
      currentTool: null,
      turnStartedAt: 0,
      edits: [
        {
          toolName: "edit",
          filePath: "lib/x.ts",
          kind: "edit",
          added: 1,
          removed: 1,
          tooLarge: false,
          hunks: [
            {
              oldStart: 1,
              oldLength: 2,
              newStart: 1,
              newLength: 2,
              lines: [
                { kind: "del", text: "old", oldNo: 1 },
                { kind: "add", text: "new", newNo: 1 },
              ],
            },
          ],
        },
      ],
    }
    const s = buildActivitySurface(snap, i18n) as A2UIish
    const r = root(s)
    expect(r.children).toContain("edit_0")
    const coll = s.components.edit_0 as {
      component: string
      label: string
      children: string[]
    }
    expect(coll.component).toBe("Collapsible")
    expect(coll.label).toBe("✏️ lib/x.ts (+1 −1)")
    expect(coll.children).toEqual(["edit_0_body"])
    const body = s.components.edit_0_body as { component: string; text: string }
    expect(body.component).toBe("Text")
    expect(body.text).toContain("--- a/lib/x.ts")
    expect(body.text).toContain("-old")
    expect(body.text).toContain("+new")
  })

  it("terminal write edit uses the fileCreated label", () => {
    const snap: TurnActivitySnapshot = {
      status: "done",
      elapsedMs: 1000,
      toolCount: 1,
      editCount: 1,
      currentTool: null,
      turnStartedAt: 0,
      edits: [
        {
          toolName: "write",
          filePath: "new.ts",
          kind: "write",
          added: 5,
          removed: 0,
          tooLarge: true,
          hunks: [],
        },
      ],
    }
    const s = buildActivitySurface(snap, i18n) as A2UIish
    const coll = s.components.edit_0 as { label: string; children: string[] }
    expect(coll.label).toBe("✏️ new.ts (+5)")
    const body = s.components.edit_0_body as { text: string }
    // tooLarge → diffSkipped note
    expect(body.text.length).toBeGreaterThan(0)
  })

  it("fallbackText is non-empty and mirrors the title + edit summaries", () => {
    const snap: TurnActivitySnapshot = {
      status: "done",
      elapsedMs: 1000,
      toolCount: 1,
      editCount: 1,
      currentTool: null,
      turnStartedAt: 0,
      edits: [
        {
          toolName: "edit",
          filePath: "a.ts",
          kind: "edit",
          added: 2,
          removed: 1,
          tooLarge: false,
          hunks: [],
        },
      ],
    }
    const s = buildActivitySurface(snap, i18n) as A2UIish
    const mirror = (s.widget ?? {}).fallbackText as string
    expect(typeof mirror).toBe("string")
    expect(mirror.length).toBeGreaterThan(0)
    expect(mirror).toContain("Done")
    expect(mirror).toContain("a.ts (+2 −1)")
  })

  it("running snapshot does not detail edits (compact)", () => {
    const snap: TurnActivitySnapshot = {
      status: "running",
      elapsedMs: 1000,
      toolCount: 1,
      editCount: 1,
      currentTool: "edit",
      turnStartedAt: 0,
      edits: [
        {
          toolName: "edit",
          filePath: "a.ts",
          kind: "edit",
          added: 1,
          removed: 1,
          tooLarge: false,
          hunks: [],
        },
      ],
    }
    const s = buildActivitySurface(snap, i18n) as A2UIish
    // running only renders currentTool, not edit Collapsibles
    expect(s.components.edit_0).toBeUndefined()
  })
})
