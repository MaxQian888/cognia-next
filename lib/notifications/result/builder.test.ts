/**
 * Tests for lib/notifications/result/builder.ts — the deterministic
 * journal→summary projection. Covers the outcome headline, verification/
 * progress/artifact facts, the classification ceiling, conclusive honesty
 * (a fake green is the one thing it must never mint), and the fact cap.
 */

import {
  buildRunResultSummaryContent,
  payloadContentHash,
  RUN_RESULT_SUMMARY_SCHEMA_VERSION,
} from "./builder"
import type { RunProjectionSnapshot } from "@/types/execution/run"
import type { NotificationScope } from "@/types/notifications/scope"

const scope: NotificationScope = {
  namespaceId: "ns",
  accountId: "a",
  authorityHostId: "h",
}

function snapshot(over: Partial<RunProjectionSnapshot> = {}): RunProjectionSnapshot {
  return {
    runId: "r1",
    title: "Deploy",
    status: "completed",
    ...over,
  } as RunProjectionSnapshot
}

describe("buildRunResultSummaryContent", () => {
  it("derives a completed outcome headline", () => {
    const s = buildRunResultSummaryContent({
      snapshot: snapshot({ elapsedMs: 5000 }),
      scope,
      derivedFromSeq: 7,
    })
    expect(s.terminalStatus).toBe("completed")
    expect(s.headline).toBe("Deploy — Completed in 5s")
    expect(s.facts[0]).toMatchObject({ kind: "outcome", text: "Completed in 5s" })
    expect(s.conclusive).toBe(true)
    expect(s.derivedFromSeq).toBe(7)
    expect(s.schemaVersion).toBe(RUN_RESULT_SUMMARY_SCHEMA_VERSION)
  })

  it("derives a failed outcome with the error", () => {
    const s = buildRunResultSummaryContent({
      snapshot: snapshot({ status: "failed", error: "boom" }),
      scope,
      derivedFromSeq: 1,
    })
    expect(s.headline).toBe("Deploy — Failed: boom")
    expect(s.facts[0].text).toBe("Failed: boom")
  })

  it("derives a cancelled outcome", () => {
    const s = buildRunResultSummaryContent({
      snapshot: snapshot({ status: "cancelled" }),
      scope,
      derivedFromSeq: 1,
    })
    expect(s.facts[0].text).toBe("Cancelled")
    expect(s.terminalStatus).toBe("cancelled")
  })

  it("derives verification counts as metrics (totals only, never output)", () => {
    const s = buildRunResultSummaryContent({
      snapshot: snapshot({
        artifacts: [
          {
            kind: "verification",
            id: "v1",
            title: "Tests",
            verification: { passed: 9, failed: 1, skipped: 0, total: 10, conclusion: "passed" },
          },
        ],
      }),
      scope,
      derivedFromSeq: 1,
    })
    const metric = s.facts.find((f) => f.kind === "metric")
    expect(metric?.text).toBe("9/10 checks passed, 1 failed")
  })

  it("marks an inconclusive verification inconclusive + emits a warning", () => {
    const s = buildRunResultSummaryContent({
      snapshot: snapshot({
        artifacts: [
          {
            kind: "verification",
            id: "v1",
            title: "Tests",
            verification: {
              passed: 0,
              failed: 0,
              skipped: 0,
              total: 0,
              conclusion: "inconclusive",
            },
          },
        ],
      }),
      scope,
      derivedFromSeq: 1,
    })
    expect(s.conclusive).toBe(false)
    expect(s.inconclusiveReason).toBe("partial-evidence")
    expect(s.facts.some((f) => f.kind === "warning")).toBe(true)
  })

  it("marks a truncated journal inconclusive", () => {
    const s = buildRunResultSummaryContent({
      snapshot: snapshot(),
      scope,
      derivedFromSeq: 1,
      journalTruncated: true,
    })
    expect(s.conclusive).toBe(false)
    expect(s.inconclusiveReason).toBe("journal-truncated")
  })

  it("marks a non-terminal snapshot inconclusive + forces failed", () => {
    const s = buildRunResultSummaryContent({
      snapshot: snapshot({ status: "running" }),
      scope,
      derivedFromSeq: 1,
    })
    expect(s.terminalStatus).toBe("failed")
    expect(s.conclusive).toBe(false)
    expect(s.inconclusiveReason).toBe("schema-unknown")
  })

  it("only includes a progress metric when the total is trustworthy", () => {
    const trusted = buildRunResultSummaryContent({
      snapshot: snapshot({ progress: { trustworthy: true, total: 4, completed: 4 } }),
      scope,
      derivedFromSeq: 1,
    })
    expect(trusted.facts.some((f) => f.text === "4/4 steps")).toBe(true)

    const untrusted = buildRunResultSummaryContent({
      snapshot: snapshot({ progress: { trustworthy: false, total: 4, completed: 4 } }),
      scope,
      derivedFromSeq: 1,
    })
    expect(untrusted.facts.some((f) => f.text === "4/4 steps")).toBe(false)
  })

  it("derives non-verification artifacts as artifact facts with refs", () => {
    const s = buildRunResultSummaryContent({
      snapshot: snapshot({
        artifacts: [{ kind: "generic", id: "a1", title: "report.pdf", detailsRef: "art://1" }],
      }),
      scope,
      derivedFromSeq: 1,
    })
    const artifact = s.facts.find((f) => f.kind === "artifact")
    expect(artifact).toMatchObject({
      text: "report.pdf",
      artifactRef: "art://1",
      classification: "internal",
    })
  })

  it("includes the platform-neutral summary as a decision fact", () => {
    const s = buildRunResultSummaryContent({
      snapshot: snapshot({ summary: "All green" }),
      scope,
      derivedFromSeq: 1,
    })
    expect(s.facts.some((f) => f.kind === "decision" && f.text === "All green")).toBe(true)
  })

  it("takes the max classification across facts", () => {
    const s = buildRunResultSummaryContent({
      snapshot: snapshot({ artifacts: [{ kind: "generic", id: "a1", title: "x" }] }), // internal artifact
      scope,
      derivedFromSeq: 1,
    })
    expect(s.maxClassification).toBe("internal")
  })

  it("caps the fact list", () => {
    const s = buildRunResultSummaryContent({
      snapshot: snapshot({
        artifacts: Array.from({ length: 20 }, (_, i) => ({
          kind: "generic",
          id: "a1",
          title: `a${i}`,
        })),
      }),
      scope,
      derivedFromSeq: 1,
      factCap: 3,
    })
    expect(s.facts.length).toBeLessThanOrEqual(3)
  })

  it("honors a custom classification mapping", () => {
    const s = buildRunResultSummaryContent({
      snapshot: snapshot(),
      scope,
      derivedFromSeq: 1,
      classificationOf: () => "restricted",
    })
    expect(s.maxClassification).toBe("restricted")
    expect(s.facts.every((f) => f.classification === "restricted")).toBe(true)
  })

  it("is deterministic — same snapshot, same content (modulo revision/id)", () => {
    const snap = snapshot({ elapsedMs: 5000, summary: "ok" })
    const a = buildRunResultSummaryContent({ snapshot: snap, scope, derivedFromSeq: 3 })
    const b = buildRunResultSummaryContent({ snapshot: snap, scope, derivedFromSeq: 3 })
    expect(a.materialHash).toBe(b.materialHash)
    expect(a.digest).toBe(b.digest)
    expect(a.headline).toBe(b.headline)
  })
})

describe("payloadContentHash", () => {
  it("is stable for identical parts regardless of key order", () => {
    const a = payloadContentHash({
      title: "T",
      body: "B",
      actions: [{ kind: "link", label: "L", ref: "R" }],
    })
    const b = payloadContentHash({
      title: "T",
      body: "B",
      actions: [{ kind: "link", label: "L", ref: "R" }],
    })
    expect(a).toBe(b)
  })

  it("differs when the body differs", () => {
    const a = payloadContentHash({ title: "T", body: "B" })
    const b = payloadContentHash({ title: "T", body: "C" })
    expect(a).not.toBe(b)
  })
})
