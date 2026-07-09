/**
 * Smoke tests for the six Lark skill families (ADR-0026).
 *
 * Verifies that every family file:
 *   1. Successfully registers its skills at module load.
 *   2. Each skill carries the correct family identifier.
 *   3. Write + destructive skills ship a hitlSurface.
 *   4. The total count matches the documented v1 catalogue.
 *   5. Mutation tier distribution matches expectations.
 */

import { getSharedBuiltInSkillRegistry } from "../registry"
import { buildConfirmSurface, runLarkCli } from "./_helpers"

// Keep everything real except runLarkCli so execute() wiring (argv shape +
// bound-adapter threading) is assertable without spawning lark-cli.
jest.mock("./_helpers", () => ({
  ...jest.requireActual("./_helpers"),
  runLarkCli: jest.fn(async () => ({ ok: true })),
}))

// Importing the barrel triggers `registerBuiltInSkill()` for every family.
// Side-effect at module load — placed at the top of this file so the
// registry is populated before any `describe` runs.
import "./index"

describe("Lark skill families — registration smoke", () => {
  it("registers exactly the documented set of families", () => {
    const reg = getSharedBuiltInSkillRegistry()
    expect(reg.families().sort()).toEqual([
      "lark.base",
      "lark.calendar",
      "lark.doc",
      "lark.sheets",
      "lark.task",
      "lark.wiki",
    ])
  })

  it("registers 40 skills across the six families", () => {
    const reg = getSharedBuiltInSkillRegistry()
    expect(reg.list()).toHaveLength(40)
  })

  it("every skill has platforms === ['lark']", () => {
    const reg = getSharedBuiltInSkillRegistry()
    for (const skill of reg.list()) {
      expect(skill.platforms).toEqual(["lark"])
    }
  })

  it("write + destructive skills all ship hitlSurface", () => {
    const reg = getSharedBuiltInSkillRegistry()
    const needsHitl = reg
      .list()
      .filter((s) => s.mutation === "write" || s.mutation === "destructive")
    expect(needsHitl.length).toBeGreaterThan(0)
    for (const skill of needsHitl) {
      expect(skill.hitlSurface).toBeDefined()
    }
  })

  it("destructive skills all have imAccess='opt-in'", () => {
    const reg = getSharedBuiltInSkillRegistry()
    const destructive = reg.listByMutation("destructive")
    for (const skill of destructive) {
      expect(skill.imAccess).toBe("opt-in")
    }
  })

  it("read skills all have imAccess='always'", () => {
    const reg = getSharedBuiltInSkillRegistry()
    const reads = reg.listByMutation("read")
    for (const skill of reads) {
      expect(skill.imAccess).toBe("always")
    }
  })

  it("mcpToolName is unique across all skills", () => {
    const reg = getSharedBuiltInSkillRegistry()
    const seen = new Set<string>()
    for (const skill of reg.list()) {
      expect(seen.has(skill.mcpToolName)).toBe(false)
      seen.add(skill.mcpToolName)
    }
  })

  it("mcpToolName follows lark_<family>_<verb> convention", () => {
    const reg = getSharedBuiltInSkillRegistry()
    for (const skill of reg.list()) {
      expect(skill.mcpToolName).toMatch(/^lark_[a-z]+_[a-z_]+$/)
    }
  })

  it("hitlSurface returns a renderable A2UI surface with Confirm + Cancel buttons", () => {
    const reg = getSharedBuiltInSkillRegistry()
    const create = reg.get("lark.calendar.create_event")
    expect(create?.hitlSurface).toBeDefined()
    const surface = create!.hitlSurface!({
      calendarId: "cal_1",
      summary: "Q4 review",
      startTime: "2026-06-01T15:00:00Z",
      endTime: "2026-06-01T16:00:00Z",
    } as never)
    expect(surface.rootId).toBeDefined()
    expect(surface.components["btn_confirm"]).toBeDefined()
    expect(surface.components["btn_cancel"]).toBeDefined()
  })
})

describe("buildConfirmSurface — helper", () => {
  it("produces a Card with Row → Confirm + Cancel buttons", () => {
    const s = buildConfirmSurface({
      surfaceId: "sfc_x",
      title: "Test",
      summary: "Do the thing?",
    })
    expect(s.rootId).toBe("sfc_x")
    expect((s.components["sfc_x"] as { component: string }).component).toBe("Card")
    expect((s.components["actions"] as { component: string }).component).toBe("Row")
  })

  it("renders detail rows when provided", () => {
    const s = buildConfirmSurface({
      surfaceId: "sfc_x",
      title: "Test",
      summary: "Body",
      details: [{ label: "When", value: "tomorrow" }],
    })
    expect(s.components["detail_0"]).toBeDefined()
  })
})

describe("bound-adapter threading (multi-account correctness)", () => {
  const runLarkCliMock = runLarkCli as jest.Mock

  it("passes the session's Lark adapterId into runLarkCli", async () => {
    const skill = getSharedBuiltInSkillRegistry().get("lark.doc.fetch")
    expect(skill).toBeDefined()
    await skill!.execute(
      { docToken: "doxcnAbCdEfGh1234567890" },
      {
        sessionId: "s1",
        imBinding: { adapterId: "cai_bound", platform: "lark", conversationKey: "oc_1" },
      }
    )
    expect(runLarkCliMock).toHaveBeenCalledWith(expect.objectContaining({ adapterId: "cai_bound" }))
  })

  it("leaves adapterId undefined for in-app sessions (bridge default applies)", async () => {
    runLarkCliMock.mockClear()
    const skill = getSharedBuiltInSkillRegistry().get("lark.doc.fetch")
    await skill!.execute({ docToken: "doxcnAbCdEfGh1234567890" }, { sessionId: "s1" })
    expect(runLarkCliMock).toHaveBeenCalledWith(expect.objectContaining({ adapterId: undefined }))
  })
})
