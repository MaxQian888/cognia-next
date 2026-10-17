import { bestOfNCli } from "./best-of-n"
import type { BestOfNGroup } from "@/types/best-of-n"

const host = { list: jest.fn(), get: jest.fn() }
const prepare = jest.fn()
const startPrepared = jest.fn()
const cancel = jest.fn()
const pick = jest.fn()
const publish = jest.fn()
const archive = jest.fn()
jest.mock("@/lib/best-of-n/host", () => ({ createBestOfNHost: () => host }))
jest.mock("@/lib/best-of-n/entry", () => ({
  prepareBestOfNChat: (...args: unknown[]) => prepare(...args),
  startPreparedBestOfN: (...args: unknown[]) => startPrepared(...args),
}))
jest.mock("@/lib/best-of-n/service", () => ({ cancelBestOfN: (...a: unknown[]) => cancel(...a) }))
jest.mock("@/lib/best-of-n/publication", () => ({
  pickBestOfNCandidate: (...a: unknown[]) => pick(...a),
  publishBestOfNCandidate: (...a: unknown[]) => publish(...a),
  archiveBestOfN: (...a: unknown[]) => archive(...a),
}))

const group = (createdAt = 1) =>
  ({
    groupId: `g${createdAt}`,
    phase: "awaitingSelection",
    n: 2,
    baseSha: "base",
    targetRef: "best-of-n/x",
    targetIsNew: true,
    selectedCandidateId: null,
    archiveStatus: "pending",
    error: null,
    createdAt,
    candidates: [
      {
        candidateId: "c1",
        index: 0,
        agent: { agentId: "char", model: "m" },
        status: "succeeded",
        headSha: "h1",
        hasChanges: true,
        costUsd: 0.5,
        error: null,
      },
      {
        candidateId: "c2",
        index: 1,
        agent: { agentId: "char", provider: "cognia:external-agent:codex-1" },
        status: "failed",
        headSha: null,
        hasChanges: false,
        costUsd: null,
        error: "boom",
      },
    ],
  }) as unknown as BestOfNGroup

beforeEach(() => {
  jest.clearAllMocks()
  host.get.mockResolvedValue(group())
})

it("lists newest first and keeps external runtime and unknown cost visible", async () => {
  host.list.mockResolvedValue([group(1), group(2)])
  const result = await bestOfNCli({ action: "list" })
  if (!result.ok || !("runs" in result)) throw new Error("expected runs")
  expect(result.runs.map((run) => run.groupId)).toEqual(["g2", "g1"])
  expect(result.runs[0].candidates[1]).toMatchObject({
    index: 2,
    runtime: "external",
    agent: "codex-1",
    costUsd: null,
  })
})

it("starts through the same preview and start path as the composer", async () => {
  prepare.mockResolvedValue({ targetRef: "best-of-n/r", branches: ["main"] })
  startPrepared.mockResolvedValue(group())
  await bestOfNCli({ action: "start", sessionId: "s", prompt: "fix", agents: ["session", "codex"] })
  expect(prepare).toHaveBeenCalledWith("s", "fix", 2, ["session", "codex"])
  expect(startPrepared).toHaveBeenCalledWith(expect.anything(), {
    targetRef: "best-of-n/r",
    targetIsNew: true,
  })
  await bestOfNCli({ action: "start", sessionId: "s", prompt: "fix", existingBranch: "main" })
  expect(startPrepared).toHaveBeenLastCalledWith(expect.anything(), {
    targetRef: "main",
    targetIsNew: false,
  })
  expect(
    await bestOfNCli({ action: "start", sessionId: "s", prompt: "fix", existingBranch: "origin/x" })
  ).toEqual({
    ok: false,
    error: "no local branch named origin/x",
  })
  expect(await bestOfNCli({ action: "start", sessionId: "s", prompt: "fix", n: 5 })).toMatchObject({
    ok: false,
  })
})

it("refuses select and publish unless the CLI confirmed on a terminal", async () => {
  for (const action of ["select", "publish"]) {
    expect(await bestOfNCli({ action, groupId: "g1", candidate: 1 })).toEqual({
      ok: false,
      error: `${action} requires confirmation on an interactive terminal`,
    })
  }
  expect(pick).not.toHaveBeenCalled()
  expect(publish).not.toHaveBeenCalled()
})

it("selects by number or id and reports exact-head checks, then publishes", async () => {
  pick.mockResolvedValue({
    group: group(),
    checks: [{ profileId: "unit", outcome: "passed", headSha: "h1", logTail: "secret" }],
    requiredChecks: ["unit"],
  })
  const selected = await bestOfNCli({
    action: "select",
    groupId: "g1",
    candidate: 1,
    confirmedOnTty: true,
  })
  expect(pick).toHaveBeenCalledWith("g1", "c1")
  expect(selected).toMatchObject({
    ok: true,
    checks: [{ profileId: "unit", outcome: "passed", headSha: "h1" }],
  })
  expect(JSON.stringify(selected)).not.toContain("secret")
  expect(
    await bestOfNCli({ action: "select", groupId: "g1", candidate: "c9", confirmedOnTty: true })
  ).toEqual({
    ok: false,
    error: "no such candidate in this run",
  })
  publish.mockResolvedValue({
    group: group(),
    outcome: { kind: "blocked", reason: "target_checked_out_dirty", run: { secret: true } },
    archiveError: null,
    releaseError: null,
  })
  expect(
    await bestOfNCli({ action: "publish", groupId: "g1", confirmedOnTty: true })
  ).toMatchObject({
    ok: true,
    outcome: { kind: "blocked", reason: "target_checked_out_dirty" },
  })
})

it("cancels, archives and turns thrown errors into a structured refusal", async () => {
  cancel.mockResolvedValue(group())
  archive.mockResolvedValue({ group: group(), archiveError: "session offline" })
  expect(await bestOfNCli({ action: "cancel", groupId: "g1" })).toMatchObject({ ok: true })
  expect(await bestOfNCli({ action: "archive", groupId: "g1" })).toMatchObject({
    archiveError: "session offline",
  })
  host.get.mockRejectedValueOnce(new Error("Best-of-N group not found: x"))
  expect(await bestOfNCli({ action: "status", groupId: "x" })).toEqual({
    ok: false,
    error: "Best-of-N group not found: x",
  })
  expect(await bestOfNCli({ action: "status" })).toEqual({
    ok: false,
    error: "status requires a groupId",
  })
})
