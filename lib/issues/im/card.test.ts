import type { Issue } from "@/types/issues"
import {
  DEFAULT_ISSUE_CARD_LABELS,
  actorDisplay,
  buildCreateIssueConfirmSurface,
  buildIssueCardSurface,
} from "./card"

const issue: Pick<
  Issue,
  "id" | "identifier" | "title" | "description" | "status" | "priority" | "assignee"
> = {
  id: "iss-1",
  identifier: "MERC-1",
  title: "Ship the board",
  description: "all of it",
  status: "in_review",
  priority: "high",
  assignee: { kind: "agent", id: "c1", label: "Ada" },
}

describe("actorDisplay", () => {
  it("prefers the cached label, then the kind label, then unassigned", () => {
    expect(actorDisplay(undefined, DEFAULT_ISSUE_CARD_LABELS)).toBe("Unassigned")
    expect(actorDisplay({ kind: "team" }, DEFAULT_ISSUE_CARD_LABELS)).toBe("Squad")
    expect(actorDisplay({ kind: "agent", label: "Ada" }, DEFAULT_ISSUE_CARD_LABELS)).toBe("Ada")
  })
})

describe("buildIssueCardSurface", () => {
  it("renders meta, description, one hinted button per move target, Run and Open", () => {
    const surface = buildIssueCardSurface({
      surfaceId: "s1",
      issue,
      project: { name: "Mercury", key: "MERC" },
      moveTargets: ["done", "canceled"],
      canRun: true,
      openHref: "https://app/issues?id=iss-1",
    })
    const c = surface.components as Record<string, Record<string, unknown>>
    expect(surface.rootId).toBe("root")
    expect(surface.title).toBe("MERC-1 Ship the board")
    expect(c.root.children).toEqual(["meta", "description", "actions", "open"])
    expect(c.meta.text).toBe("Status: In review · Assignee: Ada · Priority: high · MERC · Mercury")
    expect(c.actions.children).toEqual(["move_done", "move_canceled", "run"])
    expect(c.move_done).toMatchObject({
      component: "Button",
      text: "Move to Done",
      action: "move:done",
      bindingKind: "issue_action",
      bindingPayload: { action: "move", issueId: "iss-1", to: "done" },
    })
    expect(c.run).toMatchObject({
      variant: "primary",
      bindingPayload: { action: "run", issueId: "iss-1" },
    })
    expect(c.open).toMatchObject({ component: "Link", href: "https://app/issues?id=iss-1" })
    const mirror = String(surface.widget?.fallbackText)
    expect(mirror).toContain("# MERC-1 Ship the board")
    expect(mirror).toContain("1. Move to Done")
    expect(mirror).toContain("3. ▶ Run")
    expect(mirror).toContain("Open on the board: https://app/issues?id=iss-1")
  })

  it("explains a runtime-owned issue and omits actions when nothing is legal", () => {
    const surface = buildIssueCardSurface({
      surfaceId: "s2",
      issue: { ...issue, description: undefined, assignee: undefined },
      moveTargets: [],
      canRun: false,
      runActive: true,
      openHref: "/issues?id=iss-1",
      labels: { runtimeOwned: "Busy." },
    })
    const c = surface.components as Record<string, Record<string, unknown>>
    expect(c.root.children).toEqual(["meta", "runtimeOwned", "open"])
    expect(c.meta.text).toContain("Assignee: Unassigned")
    expect(c.actions).toBeUndefined()
    expect(String(surface.widget?.fallbackText)).toContain("Busy.")
  })
})

describe("buildCreateIssueConfirmSurface", () => {
  it("lists the remembered project first, one hinted button per project, and cancel", () => {
    const surface = buildCreateIssueConfirmSurface({
      surfaceId: "c1",
      draft: { draftId: "d1", title: "Fix login", description: "500 on submit" },
      projects: [
        { id: "p1", name: "Mercury", key: "MERC" },
        { id: "p2", name: "Venus", key: "VEN" },
      ],
      defaultProjectId: "p2",
    })
    const c = surface.components as Record<string, Record<string, unknown>>
    expect(c.root.children).toEqual(["draftTitle", "draftBody", "summary", "actions"])
    expect(c.actions.children).toEqual(["project_p2", "project_p1", "cancel"])
    expect(c.project_p2).toMatchObject({
      text: "Create in VEN",
      variant: "primary",
      bindingKind: "issue_action",
      bindingPayload: {
        action: "create",
        issueProjectId: "p2",
        draft: { draftId: "d1", title: "Fix login", description: "500 on submit" },
      },
    })
    expect(c.project_p1.variant).toBeUndefined()
    expect(c.cancel).toMatchObject({ bindingPayload: { action: "cancel_create", draftId: "d1" } })
    const mirror = String(surface.widget?.fallbackText)
    expect(mirror).toContain("1. Create in VEN · Venus")
    expect(mirror).toContain("2. Create in MERC · Mercury")
    expect(mirror).toContain("3. Cancel")
  })

  it("works without a description or a remembered project", () => {
    const surface = buildCreateIssueConfirmSurface({
      surfaceId: "c2",
      draft: { draftId: "d2", title: "t" },
      projects: [{ id: "p1", name: "M", key: "M" }],
      labels: { title: "File it?" },
    })
    const c = surface.components as Record<string, Record<string, unknown>>
    expect(c.root.children).toEqual(["draftTitle", "summary", "actions"])
    expect(surface.title).toBe("File it?")
    expect(c.actions.children).toEqual(["project_p1", "cancel"])
  })
})
