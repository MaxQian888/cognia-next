import type { IssueRun, IssueRunArtifact } from "@/types/issues"
import {
  artifactDeliverableHref,
  deliverableKey,
  groupIssueDeliverables,
  createDeliveryReceipt,
  deliveryDigest,
  deliverySnapshot,
} from "./deliverables"

function run(id: string, startedAt: number, artifacts: IssueRunArtifact[]): IssueRun {
  return {
    id,
    issueId: "i1",
    projectId: "w1",
    adapterId: "agent-task",
    kind: "agent-task",
    targetId: "t",
    status: "succeeded",
    by: { kind: "human" },
    startedAt,
    updatedAt: startedAt,
    artifacts,
  }
}

const deliverable = (label: string, href: string, linkedAt?: number): IssueRunArtifact => ({
  label,
  href,
  deliverable: true,
  ...(linkedAt !== undefined ? { linkedAt } : {}),
})

it("keys labels case- and space-insensitively and spells the artifact href", () => {
  expect(deliverableKey("  Weekly   Report.CSV ")).toBe("weekly report.csv")
  expect(artifactDeliverableHref("a1")).toBe("artifact:a1")
})

it("groups deliverables into versions across runs, newest first, leaving traces out", () => {
  const runs = [
    run("r2", 200, [
      { label: "Session (attempt 1)", href: "/?session=s2" },
      deliverable("report.csv", "artifact:b", 250),
    ]),
    run("r1", 100, [
      deliverable("Report.csv", "artifact:a", 150),
      deliverable("summary.md", "artifact:c", 160),
    ]),
    run("r3", 300, [deliverable("report.csv", "https://x/r3")]),
  ]
  const groups = groupIssueDeliverables(runs)
  expect(groups.map((group) => group.key)).toEqual(["report.csv", "summary.md"])
  const [report] = groups
  expect(report!.label).toBe("report.csv")
  expect(report!.versions.map((v) => [v.runId, v.version, v.linkedAt])).toEqual([
    ["r3", 3, 300],
    ["r2", 2, 250],
    ["r1", 1, 150],
  ])
})

it("answers nothing when no run handed anything over", () => {
  expect(
    groupIssueDeliverables([run("r1", 1, [{ label: "PR", href: "https://x/pull/1" }])])
  ).toEqual([])
})

it("addresses immutable delivery content, excluding mutable access bookkeeping", () => {
  const source = {
    id: "a",
    type: "code",
    title: "Report",
    content: "v1",
    version: 1,
    sessionId: "s",
    messageId: "m",
    createdAt: 1,
    updatedAt: 2,
    metadata: { lastAccessedAt: 3 },
  } as const
  const snapshot = deliverySnapshot(source)
  const receipt = createDeliveryReceipt("artifact:a", { snapshot })
  expect(snapshot.metadata).not.toHaveProperty("lastAccessedAt")
  expect(
    deliveryDigest("artifact:a", { snapshot: deliverySnapshot({ ...source, updatedAt: 4 }) })
  ).toBe(receipt.digest)
  expect(deliveryDigest("artifact:a", { snapshot: { ...snapshot, content: "v2" } })).not.toBe(
    receipt.digest
  )
  expect(() => createDeliveryReceipt("https://example.com", {})).toThrow("no pinned version")
})
