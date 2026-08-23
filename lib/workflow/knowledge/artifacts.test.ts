/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import {
  openWorkflowKnowledgeArtifact,
  pruneWorkflowKnowledgeArtifacts,
  storeWorkflowKnowledgeArtifact,
} from "./artifacts"

const deps = { loadKey: async () => new Uint8Array(32).fill(9) }

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
})

afterEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
})

it("encrypts content-bearing stages and binds them to account, run, and stage", async () => {
  const ref = await storeWorkflowKnowledgeArtifact(
    {
      accountId: "acct_a",
      runId: "run_a",
      stepId: "parse",
      stage: "parsed",
      value: { originalText: "private source" },
      now: 100,
    },
    deps
  )
  const row = await getDb().workflowKnowledgeArtifacts.get(ref.artifactId)
  expect(JSON.stringify(row)).not.toContain("private source")
  await expect(
    openWorkflowKnowledgeArtifact<{ originalText: string }>(
      {
        accountId: "acct_a",
        runId: "run_a",
        artifactId: ref.artifactId,
        expectedStage: "parsed",
        now: 101,
      },
      deps
    )
  ).resolves.toEqual({ originalText: "private source" })
  await expect(
    openWorkflowKnowledgeArtifact(
      { accountId: "acct_b", runId: "run_a", artifactId: ref.artifactId, expectedStage: "parsed" },
      deps
    )
  ).rejects.toThrow("not found")
})

it("prunes expired handoff artifacts", async () => {
  await storeWorkflowKnowledgeArtifact(
    { accountId: "acct_a", runId: "run_a", stepId: "parse", stage: "parsed", value: {}, now: 0 },
    deps
  )
  await expect(pruneWorkflowKnowledgeArtifacts(24 * 60 * 60 * 1_000)).resolves.toBe(1)
})
