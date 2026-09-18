// Coverage for disclosure (V2): clipping a fact set to a target's ceiling,
// the "+N more" marker, artifact/detail-link suppression on low-trust
// profiles, and privacy-mode title redaction. Pure — no Dexie.

import { clipFactsToProfile, renderDisclosedPayload } from "./disclosure"
import {
  DEFAULT_DISCLOSURE_PROFILES,
  disclosureProfileById,
  type NotificationDisclosureProfile,
} from "@/types/notifications/target"
import type { RunResultFact } from "@/types/notifications/result"

const profile = (id: string): NotificationDisclosureProfile =>
  disclosureProfileById(id, DEFAULT_DISCLOSURE_PROFILES)

function fact(
  kind: RunResultFact["kind"],
  classification: RunResultFact["classification"],
  text = "f"
): RunResultFact {
  return { kind, text, classification }
}

describe("clipFactsToProfile", () => {
  it("keeps facts at/below the ceiling verbatim", () => {
    const facts = [fact("outcome", "public"), fact("metric", "internal")]
    const r = clipFactsToProfile(facts, profile("internal"))
    expect(r.visibleFacts).toHaveLength(2)
    expect(r.clippedFactCount).toBe(0)
    expect(r.appliedLevel).toBe("internal")
  })

  it("drops + counts facts above the ceiling", () => {
    const facts = [
      fact("outcome", "public"),
      fact("diagnostic", "confidential"),
      fact("diagnostic", "restricted"),
    ]
    const r = clipFactsToProfile(facts, profile("internal"))
    expect(r.visibleFacts).toHaveLength(1)
    expect(r.clippedFactCount).toBe(2)
    // The applied level is the richest that SURVIVED.
    expect(r.appliedLevel).toBe("public")
  })

  it("never widens the ceiling — a confidential profile still clips restricted", () => {
    const r = clipFactsToProfile([fact("diagnostic", "restricted")], profile("confidential"))
    expect(r.visibleFacts).toHaveLength(0)
    expect(r.clippedFactCount).toBe(1)
  })
})

describe("renderDisclosedPayload", () => {
  const base = {
    title: "Run failed: deploy",
    genericTitle: "A run notification",
    level: "error" as const,
    detailRef: "/agent-runs?run=r1",
  }

  it("renders the full body for an internal target", () => {
    const p = renderDisclosedPayload({
      ...base,
      facts: [
        fact("outcome", "public", "Failed: boom"),
        fact("artifact", "internal", "report.txt"),
      ],
      profileId: "internal",
    })
    expect(p.title).toBe("Run failed: deploy")
    expect(p.body).toContain("Failed: boom")
    expect(p.body).toContain("report.txt")
    expect(p.clippedFactCount).toBe(0)
    expect(p.disclosureLevel).toBe("internal")
    expect(p.actions?.[0]?.ref).toBe("/agent-runs?run=r1")
  })

  it("renders a counts-only body + generic title for a public webhook", () => {
    const p = renderDisclosedPayload({
      ...base,
      facts: [fact("outcome", "public", "ok"), fact("diagnostic", "confidential", "secret")],
      profileId: "public",
    })
    // privacyMode strips the business title.
    expect(p.title).toBe("A run notification")
    // The confidential fact is clipped, never shown.
    expect(p.body).not.toContain("secret")
    expect(p.body).toContain("+1 more")
    expect(p.clippedFactCount).toBe(1)
  })

  it("drops the artifact link when the profile forbids it", () => {
    const p = renderDisclosedPayload({
      ...base,
      facts: [
        { kind: "artifact", text: "report", classification: "public", artifactRef: "cognia://a/1" },
      ],
      profileId: "public",
    })
    expect(p.body).not.toContain("cognia://a/1")
    expect(p.body).toContain("report")
  })

  it("keeps the artifact link when the profile allows it", () => {
    const p = renderDisclosedPayload({
      ...base,
      facts: [
        {
          kind: "artifact",
          text: "report",
          classification: "internal",
          artifactRef: "cognia://a/1",
        },
      ],
      profileId: "internal",
    })
    expect(p.body).toContain("cognia://a/1")
  })

  it("drops the detail link when the profile forbids it", () => {
    const noLink: NotificationDisclosureProfile = {
      id: "no-link",
      maxLevel: "internal",
      allowArtifactLinks: true,
      allowAttachments: false,
      allowDetailLink: false,
    }
    const p = renderDisclosedPayload({
      ...base,
      facts: [fact("outcome", "internal", "x")],
      profileId: "no-link",
      profiles: [noLink],
    })
    expect(p.actions).toBeUndefined()
  })

  it("produces a stable contentHash for the same render", () => {
    const args = { ...base, facts: [fact("outcome", "public", "x")], profileId: "internal" }
    expect(renderDisclosedPayload(args).contentHash).toBe(renderDisclosedPayload(args).contentHash)
  })
})
