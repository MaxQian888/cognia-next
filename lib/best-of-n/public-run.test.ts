import { toPublicBestOfNRun } from "./public-run"
import type { BestOfNGroup } from "@/types/best-of-n"

it("exposes progress and runtimes without lease, version or workspace authority", () => {
  const group = {
    groupId: "g",
    requestId: "r",
    phase: "running",
    n: 2,
    baseSha: "base",
    targetRef: "best-of-n/r",
    targetIsNew: true,
    selectedCandidateId: null,
    archiveStatus: "pending",
    error: null,
    createdAt: 1,
    version: 7,
    ownerId: "owner",
    ownerLeaseExpiresAt: 9,
    sourceRoot: "/repo",
    candidates: [
      {
        candidateId: "c1",
        index: 0,
        agent: { agentId: "char", provider: "cognia:external-agent:codex-1" },
        status: "running",
        headSha: null,
        hasChanges: false,
        costUsd: null,
        error: null,
        physicalRoot: "/workspaces/c1",
        workspaceBundleId: "bundle",
        childSessionId: "s1",
      },
    ],
  } as unknown as BestOfNGroup
  const run = toPublicBestOfNRun(group)
  expect(run.candidates[0]).toEqual({
    index: 1,
    candidateId: "c1",
    status: "running",
    runtime: "external",
    agent: "codex-1",
    model: null,
    headSha: null,
    hasChanges: false,
    costUsd: null,
    error: null,
  })
  const serialized = JSON.stringify(run)
  for (const secret of ["owner", "/workspaces", "bundle", "/repo", '"version"'])
    expect(serialized).not.toContain(secret)
})
