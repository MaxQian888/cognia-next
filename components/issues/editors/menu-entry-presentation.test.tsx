/** @jest-environment jsdom */

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

import { renderHook } from "@testing-library/react"
import type { IssueMenuEntry } from "@/lib/issues/menu-model"
import type { IssueProject } from "@/types/issues"
import type { LabelRow } from "@/types/labels"
import type { AssigneeOption } from "../assignee-picker"
import { useMenuEntryPresentation } from "./menu-entry-presentation"

const entry = (id: string): IssueMenuEntry => ({
  id,
  action: { kind: "delete" },
  disabled: false,
  checked: false,
})

const label: LabelRow = {
  id: "l1",
  scope: "issue",
  name: "bug",
  color: "#ff0000",
  sortOrder: 0,
  createdAt: 0,
  updatedAt: 0,
}
const project: IssueProject = {
  id: "p1",
  projectId: "w1",
  key: "MERC",
  name: "Mercury",
  icon: "🚀",
  status: "in_progress",
  priority: "medium",
  resources: [],
  createdAt: 0,
  updatedAt: 0,
}
const scout: AssigneeOption = {
  key: "agent:a1",
  actor: { kind: "agent", id: "a1", label: "Scout" },
  group: "agent",
}

/**
 * A real custom hook at module scope, passed to `renderHook` by reference:
 * calling the hook inside the callback trips `react-hooks/rules-of-hooks`.
 */
const useFixture = () =>
  useMenuEntryPresentation({ labels: [label], projects: [project], assigneeOptions: [scout] })

function usePresentation() {
  return renderHook(useFixture).result.current
}

describe("useMenuEntryPresentation", () => {
  it("names each section from the detail catalogue", () => {
    const p = usePresentation()
    expect(p.sectionLabel("status")).toBe("detail.status")
    expect(p.sectionLabel("labels")).toBe("detail.labels")
  })

  it("localizes enum entries", () => {
    const p = usePresentation()
    expect(p.entryLabel("status", entry("in_review"))).toBe("status.in_review")
    expect(p.entryLabel("priority", entry("urgent"))).toBe("priority.urgent")
  })

  it("resolves ids to names", () => {
    const p = usePresentation()
    expect(p.entryLabel("labels", entry("l1"))).toBe("bug")
    expect(p.entryLabel("project", entry("p1"))).toBe("Mercury")
    expect(p.entryLabel("assignee", entry("agent:a1"))).toBe("Scout")
  })

  it("names the unassign entry", () => {
    expect(usePresentation().entryLabel("assignee", entry("none"))).toBe("actor.unassigned")
  })

  it("falls back to the raw id when nothing resolves it", () => {
    const p = usePresentation()
    // A Character deleted since the issue was assigned leaves a dangling key.
    expect(p.entryLabel("assignee", entry("agent:gone"))).toBe("agent:gone")
    expect(p.entryLabel("labels", entry("ghost"))).toBe("ghost")
    expect(p.entryLabel("project", entry("ghost"))).toBe("ghost")
  })

  it("gives status and priority a glyph", () => {
    const p = usePresentation()
    expect(p.entryIcon("status", entry("done"))).not.toBeNull()
    expect(p.entryIcon("priority", entry("high"))).not.toBeNull()
  })

  it("gives a label a swatch and a container its icon", () => {
    const p = usePresentation()
    expect(p.entryIcon("labels", entry("l1"))).not.toBeNull()
    expect(p.entryIcon("project", entry("p1"))).not.toBeNull()
  })

  it("gives an assignee no glyph, and an unresolved id none either", () => {
    const p = usePresentation()
    expect(p.entryIcon("assignee", entry("agent:a1"))).toBeNull()
    expect(p.entryIcon("labels", entry("ghost"))).toBeNull()
    expect(p.entryIcon("project", entry("ghost"))).toBeNull()
  })
})
