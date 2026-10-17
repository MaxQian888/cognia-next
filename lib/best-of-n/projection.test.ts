/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { getDb } from "@/lib/db/schema"
import type { BestOfNGroup } from "@/types/best-of-n"
import {
  canManageBestOfNRuns,
  getBestOfNRun,
  getBestOfNRunForMessage,
  listBestOfNRuns,
  projectBestOfNGroup,
  rebuildBestOfNRunSummaries,
  refreshBestOfNRun,
} from "./projection"
import { isTauri } from "@/lib/platform/detect"
import { isRemoteHostActive } from "@/lib/tauri/transport-routing"

jest.mock("@/lib/platform/detect", () => ({ isTauri: jest.fn(() => false) }))
jest.mock("@/lib/tauri/transport-routing", () => ({ isRemoteHostActive: jest.fn(() => false) }))
jest.mock("./host", () => ({ createBestOfNHost: jest.fn() }))
jest.mock("@/lib/scm/host", () => ({ createScmHost: jest.fn() }))

function group(version = 1): BestOfNGroup {
  return {
    groupId: "group",
    requestId: "parent",
    repositoryId: "repo",
    repoCommonDir: "/repo/.git",
    sourceRoot: "/repo",
    baseSha: "frozen",
    checkoutHadUncommittedChanges: true,
    targetRef: "refs/heads/result",
    targetIsNew: true,
    n: 2,
    budgetPolicy: {},
    teamRunId: "team",
    phase: "running",
    selectedCandidateId: null,
    selectedHeadSha: null,
    integrationId: null,
    version,
    ownerId: "owner",
    ownerLeaseExpiresAt: 9000,
    archiveStatus: "pending",
    archiveError: null,
    error: null,
    createdAt: 100,
    updatedAt: 100 + version,
    candidates: [0, 1].map((index) => ({
      candidateId: `c${index}`,
      index,
      agent: { agentId: "agent" },
      childSessionId: `s${index}`,
      workspaceBundleId: null,
      physicalRoot: null,
      changesetId: null,
      headSha: null,
      status: "pending",
      hasChanges: false,
      costUsd: null,
      startedAt: null,
      finishedAt: null,
      error: null,
    })),
  }
}

beforeEach(async () => {
  await getDb().bestOfNRuns.clear()
  await getDb().messages.clear()
  await getDb().sessions.clear()
  jest.mocked(isTauri).mockReturnValue(false)
  jest.mocked(isRemoteHostActive).mockReturnValue(false)
})

it("retains chat binding, unknown cost, check policy, and separate cleanup errors across Host refresh", async () => {
  await projectBestOfNGroup(group(), {
    parentSessionId: "session",
    parentMessageId: "parent",
    projectId: "project",
    requiredChecks: ["unit"],
    sessionArchiveError: "session locked",
  })
  const published = { ...group(3), phase: "published" as const, integrationId: "integration" }
  await projectBestOfNGroup(published)
  const row = await projectBestOfNGroup(group(2))
  expect(row).toMatchObject({
    parentSessionId: "session",
    parentMessageId: "parent",
    projectId: "project",
    requiredChecks: ["unit"],
    sessionArchiveError: "session locked",
    group: { version: 3, phase: "published" },
  })
  expect(row.group.candidates[0].costUsd).toBeNull()
  expect(await getBestOfNRun("group")).toEqual(row)
  expect(await getBestOfNRunForMessage("parent")).toEqual(row)
  expect(await listBestOfNRuns("session")).toEqual([row])
  expect(await projectBestOfNGroup(published)).toEqual(row)
  await projectBestOfNGroup(published, { sessionArchiveError: null })
  expect((await getBestOfNRun("group"))?.sessionArchiveError).toBeNull()
})

it("rebuilds the group and parent binding from the ledger request id and durable messages", async () => {
  await getDb().messages.put({
    id: "parent",
    sessionId: "session",
    role: "assistant",
    parts: [],
    createdAt: 100,
  })
  await getDb().sessions.put({
    id: "s0",
    title: "Candidate",
    projectId: "project",
    createdAt: 100,
    updatedAt: 100,
  })
  await getDb().messages.put({
    id: "reply",
    sessionId: "s0",
    role: "assistant",
    parts: [{ type: "text", text: "Completed" }],
    createdAt: 200,
  })
  const list = jest.fn().mockResolvedValue([group()])
  const getChangeset = jest.fn()
  const rows = await rebuildBestOfNRunSummaries({ list }, { getChangeset })
  expect(rows[0]).toMatchObject({
    id: "group",
    parentMessageId: "parent",
    parentSessionId: "session",
    projectId: "project",
    summaries: { c0: "Completed" },
  })
  expect(list).toHaveBeenCalledTimes(1)
})

it("syncs only exact-head changeset evidence and reconstructs approved check names", async () => {
  const value = group()
  value.candidates[0].changesetId = "change"
  value.candidates[0].headSha = "head"
  const changeset = {
    changesetId: "change",
    headSha: "head",
    version: 2,
    requiredChecks: ["unit"],
    files: [],
    checks: [],
  }
  const getChangeset = jest.fn().mockResolvedValue(changeset)
  const get = jest.fn().mockResolvedValue(value)
  const row = await refreshBestOfNRun("group", { get }, { getChangeset })
  expect(row.candidateChangesets?.c0).toEqual(changeset)
  expect(row.requiredChecks).toEqual(["unit"])
  getChangeset.mockResolvedValue({ ...changeset, version: 1 })
  expect(
    (await refreshBestOfNRun("group", { get }, { getChangeset })).candidateChangesets?.c0.version
  ).toBe(2)
  getChangeset.mockResolvedValue({ ...changeset, headSha: "different" })
  value.candidates[0].headSha = "new-head"
  value.version++
  expect((await refreshBestOfNRun("group", { get }, { getChangeset })).candidateChangesets).toEqual(
    {}
  )
})

it("offers management only on the executing desktop, never a paired or browser mirror", () => {
  expect(canManageBestOfNRuns()).toBe(false)
  jest.mocked(isTauri).mockReturnValue(true)
  expect(canManageBestOfNRuns()).toBe(true)
  jest.mocked(isRemoteHostActive).mockReturnValue(true)
  expect(canManageBestOfNRuns()).toBe(false)
})

it("advances the shared sync watermark across different groups written in the same millisecond", async () => {
  const now = jest.spyOn(Date, "now").mockReturnValue(1000)
  try {
    const first = await projectBestOfNGroup(group(1))
    const latestFirst = await projectBestOfNGroup(group(2))
    const second = await projectBestOfNGroup({
      ...group(1),
      groupId: "second",
      requestId: "second-parent",
    })
    expect(latestFirst.updatedAt).toBeGreaterThan(first.updatedAt)
    expect(second.updatedAt).toBeGreaterThan(latestFirst.updatedAt)
    expect(
      (await getDb().bestOfNRuns.where("updatedAt").above(latestFirst.updatedAt).toArray()).map(
        (row) => row.id
      )
    ).toEqual(["second"])
  } finally {
    now.mockRestore()
  }
})
