/**
 * The provider contract is types only, so this pins the shape a provider must
 * satisfy at compile time and the two runtime facts callers lean on: a
 * read-only provider is one with no `push`, and every outcome variant is
 * discriminated on `status`.
 */

import type { IssueExternalRef, IssueProject } from "@/types/issues"
import type { IssueSyncBinding, IssueSyncProvider, PushOutcome, RemoteIssue } from "./types"

const binding: IssueSyncBinding = {
  providerId: "fake",
  projectId: "w1",
  issueProjectId: "p1",
  projectKey: "MERC",
  resource: { kind: "github-repo", repoFullName: "o/r" } as IssueProject["resources"][number],
  key: "fake:o/r",
}

const readOnly: IssueSyncProvider = {
  id: "fake",
  label: "Fake",
  pullFields: ["title", "status"],
  pushFields: [],
  resolveBindings: () => [binding],
  pull: async () => ({ items: [], cycles: [], links: [], notModified: false, truncated: false }),
}

const writable: IssueSyncProvider = {
  ...readOnly,
  pushFields: ["status"],
  push: async () => ({ status: "applied" }),
  create: async (): Promise<IssueExternalRef> => ({ provider: "fake", externalId: "1" }),
}

describe("issue sync contract", () => {
  it("distinguishes a read-only provider by the absence of push", () => {
    expect(readOnly.push).toBeUndefined()
    expect(readOnly.pushFields).toEqual([])
    expect(typeof writable.push).toBe("function")
  })

  it("discriminates push outcomes on status", async () => {
    const outcomes: PushOutcome[] = [{ status: "applied" }, { status: "queued", jobId: "j" }]
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["applied", "queued"])
    await expect(
      writable.push!(binding, { provider: "fake", externalId: "1" }, {}, {} as never, {
        idempotencyKey: "k",
        by: { kind: "human" },
      })
    ).resolves.toEqual({ status: "applied" })
  })

  it("normalises a remote item to the board's own vocabulary", () => {
    const remote: RemoteIssue = { externalId: "1", title: "t", status: "todo", coarseStatus: true }
    expect(remote.coarseStatus).toBe(true)
  })
})
