import { buildSendOptions, buildWorkingSetPostCompaction } from "./claude-chat-send-options"

describe("Claude chat send-option seam", () => {
  it("exports the send-option resolver", () => {
    expect(typeof buildSendOptions).toBe("function")
  })

  it("restores active working-set entries only for the pending compaction phase", () => {
    const workingSet = {
      contractVersion: 1 as const,
      revision: 2,
      updatedAt: 20,
      entries: [
        {
          id: "active",
          kind: "decision" as const,
          summary: "Reuse the execution journal",
          status: "active" as const,
          origin: "agent" as const,
          refs: [],
          createdAt: 10,
          updatedAt: 20,
        },
        {
          id: "resolved",
          kind: "fact" as const,
          summary: "Do not restore this",
          status: "resolved" as const,
          origin: "agent" as const,
          refs: [],
          createdAt: 10,
          updatedAt: 20,
        },
      ],
    }

    expect(buildWorkingSetPostCompaction(null, workingSet)).toBeUndefined()
    const recovery = buildWorkingSetPostCompaction(3, workingSet)
    expect(recovery).toMatchObject({ phaseNumber: 3 })
    expect(recovery?.durableInstructions).toContain("Reuse the execution journal")
    expect(recovery?.durableInstructions).not.toContain("Do not restore this")
  })

  it("blocks an unsafe persisted resource reference at the outbound boundary", () => {
    expect(() =>
      buildWorkingSetPostCompaction(2, {
        contractVersion: 1,
        revision: 1,
        updatedAt: 20,
        entries: [
          {
            id: "unsafe",
            kind: "resource",
            summary: "Inspect the resource",
            status: "active",
            origin: "agent",
            refs: [{ namespace: "cognia", type: "file", id: "jane@example.com" }],
            createdAt: 10,
            updatedAt: 20,
          },
        ],
      })
    ).toThrow("PII gate")
  })

  it("places the encrypted checkpoint before the current working set", () => {
    const recovery = buildWorkingSetPostCompaction(
      2,
      {
        contractVersion: 1,
        revision: 1,
        updatedAt: 20,
        entries: [
          {
            id: "active",
            kind: "fact",
            summary: "Current state",
            status: "active",
            origin: "agent",
            refs: [],
            createdAt: 10,
            updatedAt: 20,
          },
        ],
      },
      "Compaction checkpoint compact-1"
    )
    expect(recovery?.durableInstructions?.indexOf("Compaction checkpoint")).toBeLessThan(
      recovery?.durableInstructions?.indexOf("Active run working set") ?? 0
    )
  })
})
