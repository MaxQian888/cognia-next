import type { AssigneeOption } from "@/components/issues/assignee-picker"
import { statusCategoryOf } from "@/types/issues"
import type { IssueProject } from "@/types/issues"
import type { UnifiedIssueItem } from "@/types/issues/unified"
import { FULL_ISSUE_CAPABILITIES, READ_ONLY_ISSUE_CAPABILITIES } from "@/types/issues/unified"
import type { LabelRow } from "@/types/labels"
import { buildIssueMenuSections, canDeleteIssue, type IssueMenuSection } from "./menu-model"

function item(over: Partial<UnifiedIssueItem> = {}): UnifiedIssueItem {
  const kind = over.kind ?? "local"
  return {
    unifiedId: `${kind}:i1`,
    kind,
    sourceId: "i1",
    identifier: "MERC-1",
    title: "Ship it",
    status: "todo",
    statusCategory: statusCategoryOf("todo"),
    priority: "none",
    labelIds: [],
    order: 0,
    createdAt: 1,
    updatedAt: 1,
    origin: { deepLinkHref: "/issues" },
    capabilities: kind === "local" ? FULL_ISSUE_CAPABILITIES : READ_ONLY_ISSUE_CAPABILITIES,
    ...over,
  }
}

const label = (id: string, name: string): LabelRow => ({
  id,
  scope: "issue",
  name,
  sortOrder: 0,
  createdAt: 0,
  updatedAt: 0,
})

const project = (id: string, name: string): IssueProject => ({
  id,
  projectId: "w1",
  key: "MERC",
  name,
  status: "in_progress",
  priority: "medium",
  resources: [],
  createdAt: 0,
  updatedAt: 0,
})

const scout: AssigneeOption = {
  key: "agent:a1",
  actor: { kind: "agent", id: "a1", label: "Scout" },
  group: "agent",
}

function build(over: Partial<Parameters<typeof buildIssueMenuSections>[0]> = {}) {
  return buildIssueMenuSections({
    item: item(),
    running: false,
    labels: [],
    projects: [],
    assigneeOptions: [],
    ...over,
  })
}

const section = (sections: IssueMenuSection[], id: string) =>
  sections.find((candidate) => candidate.id === id)

describe("buildIssueMenuSections", () => {
  describe("shape", () => {
    it("always offers status, priority and assignee", () => {
      expect(build().map((s) => s.id)).toEqual(["status", "priority", "assignee"])
    })

    it("omits a section with nothing to offer rather than opening onto an empty panel", () => {
      expect(section(build(), "labels")).toBeUndefined()
      expect(section(build(), "project")).toBeUndefined()
    })

    it("adds labels and containers once there are some", () => {
      const sections = build({ labels: [label("l1", "bug")], projects: [project("p1", "Mercury")] })
      expect(sections.map((s) => s.id)).toEqual([
        "status",
        "priority",
        "assignee",
        "labels",
        "project",
      ])
    })

    it("offers all six statuses and all five priorities", () => {
      expect(section(build(), "status")!.entries).toHaveLength(6)
      expect(section(build(), "priority")!.entries).toHaveLength(5)
    })

    it("prepends unassign to the assignee list", () => {
      const entries = section(build({ assigneeOptions: [scout] }), "assignee")!.entries
      expect(entries.map((e) => e.id)).toEqual(["none", "agent:a1"])
    })
  })

  describe("actions", () => {
    it("carries a status action per column", () => {
      const done = section(build(), "status")!.entries.find((e) => e.id === "done")
      expect(done?.action).toEqual({ kind: "status", to: "done" })
    })

    it("carries a priority action", () => {
      const urgent = section(build(), "priority")!.entries.find((e) => e.id === "urgent")
      expect(urgent?.action).toEqual({ kind: "priority", to: "urgent" })
    })

    it("carries the actor itself, not just its key", () => {
      const entries = section(build({ assigneeOptions: [scout] }), "assignee")!.entries
      expect(entries[1].action).toEqual({ kind: "assignee", to: scout.actor })
      expect(entries[0].action).toEqual({ kind: "assignee", to: null })
    })

    it("adds a label the issue does not carry", () => {
      const entries = section(build({ labels: [label("l1", "bug")] }), "labels")!.entries
      expect(entries[0].action).toEqual({ kind: "addLabel", labelId: "l1" })
    })

    it("removes one it already carries — the same row flips meaning", () => {
      const entries = section(
        build({ item: item({ labelIds: ["l1"] }), labels: [label("l1", "bug")] }),
        "labels"
      )!.entries
      expect(entries[0].action).toEqual({ kind: "removeLabel", labelId: "l1" })
    })

    it("carries a container move", () => {
      const entries = section(build({ projects: [project("p1", "Mercury")] }), "project")!.entries
      expect(entries[0].action).toEqual({ kind: "project", issueProjectId: "p1" })
    })
  })

  describe("checked state", () => {
    it("ticks the issue's current status and priority", () => {
      const sections = build({ item: item({ status: "in_review", priority: "high" }) })
      expect(section(sections, "status")!.entries.find((e) => e.checked)?.id).toBe("in_review")
      expect(section(sections, "priority")!.entries.find((e) => e.checked)?.id).toBe("high")
    })

    it("ticks unassigned when there is no assignee", () => {
      const entries = section(build({ assigneeOptions: [scout] }), "assignee")!.entries
      expect(entries.find((e) => e.checked)?.id).toBe("none")
    })

    it("ticks the current assignee instead", () => {
      const entries = section(
        build({ item: item({ assignee: scout.actor }), assigneeOptions: [scout] }),
        "assignee"
      )!.entries
      expect(entries.find((e) => e.checked)?.id).toBe("agent:a1")
    })

    it("ticks an applied label and the current container", () => {
      const sections = build({
        item: item({ labelIds: ["l1"], issueProjectId: "p1" }),
        labels: [label("l1", "bug"), label("l2", "chore")],
        projects: [project("p1", "Mercury"), project("p2", "Venus")],
      })
      expect(
        section(sections, "labels")!
          .entries.filter((e) => e.checked)
          .map((e) => e.id)
      ).toEqual(["l1"])
      expect(
        section(sections, "project")!
          .entries.filter((e) => e.checked)
          .map((e) => e.id)
      ).toEqual(["p1"])
    })
  })

  describe("capability gating", () => {
    it("enables everything for a local row at rest", () => {
      const sections = build({ labels: [label("l1", "bug")], projects: [project("p1", "Mercury")] })
      expect(sections.every((s) => s.entries.every((e) => !e.disabled))).toBe(true)
    })

    it("disables everything for a federated row, and hides nothing", () => {
      const sections = build({
        item: item({ kind: "github" }),
        labels: [label("l1", "bug")],
        projects: [project("p1", "Mercury")],
      })
      expect(sections.map((s) => s.id)).toHaveLength(5)
      expect(sections.every((s) => s.entries.every((e) => e.disabled))).toBe(true)
    })

    it("locks only the run-owned status transitions while a run is in flight", () => {
      const sections = build({ running: true })
      const status = section(sections, "status")!.entries
      expect(status.find((e) => e.id === "in_progress")?.disabled).toBe(true)
      expect(status.find((e) => e.id === "done")?.disabled).toBe(false)
      // A non-status edit is unaffected.
      expect(section(sections, "priority")!.entries.every((e) => e.disabled)).toBe(false)
    })

    it("honours a single missing capability bit", () => {
      const sections = build({
        item: item({ capabilities: { ...FULL_ISSUE_CAPABILITIES, canAssign: false } }),
        assigneeOptions: [scout],
      })
      expect(section(sections, "assignee")!.entries.every((e) => e.disabled)).toBe(true)
      expect(section(sections, "priority")!.entries.every((e) => !e.disabled)).toBe(true)
    })
  })
})

describe("canDeleteIssue", () => {
  it("allows a local row", () => {
    expect(canDeleteIssue(item(), false)).toBe(true)
  })

  it("refuses a federated row", () => {
    expect(canDeleteIssue(item({ kind: "github" }), false)).toBe(false)
  })

  it("still allows deleting a running issue — the run does not own the row's existence", () => {
    expect(canDeleteIssue(item(), true)).toBe(true)
  })
})
