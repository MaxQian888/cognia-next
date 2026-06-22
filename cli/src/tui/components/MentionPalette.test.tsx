import React from "react"
import { render } from "@testing-library/react"

import { MentionPalette, orderByGroup } from "./MentionPalette"
import type { MentionCandidate } from "../mention/types"

const file = (id: string): MentionCandidate => ({ kind: "file", id, label: id, insert: id })
const skill = (id: string, over: Partial<MentionCandidate> = {}): MentionCandidate => ({
  kind: "skill",
  id,
  label: id,
  origin: "claude",
  insert: `@skill:${id}`,
  ...over,
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
    const { container } = render(
      <MentionPalette candidates={[]} index={0} loading loadingLabel="loading skills…" />
    )
    expect(container.textContent ?? "").toContain("loading skills…")
  })

  it("keeps a loading affordance while refreshing existing candidates", () => {
    const { container } = render(
      <MentionPalette
        candidates={[skill("cite")]}
        index={0}
        loading
        loadingLabel="loading skills…"
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("cite")
    expect(text).toContain("loading skills…")
  })

  it("marks the flattened selected row with a caret", () => {
    const { container } = render(
      <MentionPalette candidates={[file("@a"), skill("s1"), agent("a1")]} index={2} />
    )
    expect(container.textContent).toContain("❯")
    expect(container.textContent).toContain("a1")
  })

  it("shows a skill's enabled badge, metadata, and a preview line", () => {
    const { container } = render(
      <MentionPalette
        candidates={[skill("cite", { hint: "cite sources", category: "research", enabled: true })]}
        index={0}
        width={80}
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("●") // enabled badge
    expect(text).toContain("research") // category metadata
    expect(text).toContain("cite sources") // preview line (the description)
  })

  it("shows the hollow badge for a disabled skill and a warning marker", () => {
    const { container } = render(
      <MentionPalette candidates={[skill("cite", { enabled: false, warning: true })]} index={0} />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("○")
    expect(text).toContain("⚠")
  })

  it("windows a long list and shows scroll hints", () => {
    const many = Array.from({ length: 20 }, (_, i) => skill(`s${i}`))
    const { container } = render(<MentionPalette candidates={many} index={15} maxRows={5} />)
    const text = container.textContent ?? ""
    expect(text).toContain("s15")
    expect(text).toContain("↑")
    expect(text).toContain("↓")
  })
})
