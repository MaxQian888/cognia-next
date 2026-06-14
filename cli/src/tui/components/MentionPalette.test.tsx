import React from "react"
import { render } from "@testing-library/react"

import { MentionPalette, orderByGroup } from "./MentionPalette"
import type { MentionCandidate } from "../mention/types"

const file = (id: string): MentionCandidate => ({ kind: "file", id, label: id, insert: id })
const skill = (id: string, hint?: string): MentionCandidate => ({
  kind: "skill",
  id,
  label: id,
  hint,
  origin: "claude",
  insert: `@skill:${id}`,
})
const agent = (id: string): MentionCandidate => ({
  kind: "agent",
  id,
  label: id,
  origin: "agent",
  insert: `@agent:${id}`,
})

describe("orderByGroup", () => {
  it("orders files, then skills, then agents", () => {
    const mixed = [agent("a"), skill("s"), file("f")]
    expect(orderByGroup(mixed).map((c) => c.kind)).toEqual(["file", "skill", "agent"])
  })
})

describe("MentionPalette", () => {
  it("renders nothing with no candidates", () => {
    const { container } = render(<MentionPalette candidates={[]} index={0} />)
    expect(container.textContent).toBe("")
  })

  it("shows a loading row when loading with no candidates yet", () => {
    const { container } = render(<MentionPalette candidates={[]} index={0} loading />)
    expect(container.textContent ?? "").toContain("loading…")
  })

  it("appends a loading footer while refreshing existing candidates", () => {
    const { container } = render(
      <MentionPalette candidates={[skill("skill_cite")]} index={0} loading />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("skill_cite")
    expect(text).toContain("loading…")
  })

  it("renders group headers for non-empty groups and omits empty ones", () => {
    const { container } = render(
      <MentionPalette candidates={[file("@src/"), skill("skill_cite")]} index={0} />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("Files")
    expect(text).toContain("Skills")
    expect(text).not.toContain("Agents")
  })

  it("marks the flattened selected row with a caret", () => {
    const { container } = render(
      <MentionPalette candidates={[file("@a"), skill("s1"), agent("a1")]} index={2} />
    )
    expect(container.textContent).toContain("❯ a1")
  })

  it("shows a skill hint and origin", () => {
    const { container } = render(
      <MentionPalette candidates={[skill("skill_cite", "cite sources")]} index={0} />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("cite sources")
    expect(text).toContain("(claude)")
  })

  it("windows a long list and shows scroll hints", () => {
    const many = Array.from({ length: 20 }, (_, i) => skill(`s${i}`))
    const { container } = render(<MentionPalette candidates={many} index={15} maxRows={5} />)
    const text = container.textContent ?? ""
    expect(text).toContain("❯ s15")
    expect(text).toContain("↑")
    expect(text).toContain("↓")
  })

  it("prints the group header once even when the window starts mid-group", () => {
    const many = Array.from({ length: 12 }, (_, i) => skill(`s${i}`))
    const { container } = render(<MentionPalette candidates={many} index={8} maxRows={4} />)
    const headers = (container.textContent ?? "").match(/Skills/g) ?? []
    expect(headers.length).toBe(1)
  })
})
