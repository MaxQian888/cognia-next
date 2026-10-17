import {
  BestOfNAttemptError,
  candidateGrant,
  createBestOfNService,
  type BestOfNExecution,
  type BestOfNInput,
} from "./core"
import type { BestOfNHost } from "./host"
import type { BestOfNGroup, BestOfNMutation, StartBestOfN } from "@/types/best-of-n"

function fixture() {
  const input: BestOfNInput = {
    requestId: "request",
    repositoryId: "repo",
    sourceRoot: "/repo",
    targetIsNew: true,
    candidates: [
      { agentId: "a", model: "model-a" },
      { agentId: "b", model: "model-b" },
    ],
    budgetPolicy: { maxCostUsd: 4, maxDurationMs: 10000 },
    prompt: "Fix the problem",
  }
  let group: BestOfNGroup = {
    groupId: "group",
    requestId: "request",
    repositoryId: "repo",
    repoCommonDir: "/repo/.git",
    sourceRoot: "/repo",
    baseSha: "frozen",
    checkoutHadUncommittedChanges: true,
    targetRef: "refs/heads/result",
    targetIsNew: true,
    n: 2,
    budgetPolicy: input.budgetPolicy,
    teamRunId: "team",
    phase: "preparing",
    selectedCandidateId: null,
    selectedHeadSha: null,
    integrationId: null,
    version: 0,
    ownerId: "owner",
    ownerLeaseExpiresAt: Date.now() + 30000,
    archiveStatus: "pending",
    archiveError: null,
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    candidates: input.candidates.map((agent, index) => ({
      candidateId: `c${index}`,
      index,
      agent,
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
  const snapshot = () => structuredClone(group)
  const cas = (m: BestOfNMutation) => {
    expect(m.expectedVersion).toBe(group.version)
    group.version++
  }
  const host: jest.Mocked<BestOfNHost> = {
    start: jest.fn(async (_input: StartBestOfN) => snapshot()),
    get: jest.fn(async (_groupId: string) => snapshot()),
    list: jest.fn(async () => [snapshot()]),
    recover: jest.fn(async (m) => {
      expect(m.expectedVersion).toBe(group.version)
      group.ownerLeaseExpiresAt = Date.now() + m.leaseDurationMs
      return snapshot()
    }),
    archive: jest.fn(async (m) => {
      cas(m)
      group.archiveStatus = "archived"
      return snapshot()
    }),
    cancel: jest.fn(async (m) => {
      cas(m)
      group.phase = "cancelling"
      group.candidates.forEach((c) => {
        if (["pending", "running"].includes(c.status)) c.status = "cancelRequested"
      })
      return snapshot()
    }),
    select: jest.fn(async ({ mutation, candidateId, headSha }) => {
      cas(mutation)
      group.phase = "publishing"
      group.selectedCandidateId = candidateId
      group.selectedHeadSha = headSha
      group.candidates.forEach((c) => {
        if (c.candidateId !== candidateId && ["pending", "running"].includes(c.status))
          c.status = "cancelRequested"
      })
      return snapshot()
    }),
    progress: jest.fn(async ({ mutation, candidateId, ...update }) => {
      cas(mutation)
      Object.assign(
        group.candidates.find((c) => c.candidateId === candidateId)!,
        update
      )
      if (["preparing", "running"].includes(group.phase)) {
        group.phase = group.candidates.some((c) => c.status === "recoveryRequired")
          ? "recoveryRequired"
          : group.candidates.every((c) => ["succeeded", "failed", "cancelled"].includes(c.status))
            ? group.candidates.some((c) => c.status === "succeeded")
              ? "awaitingSelection"
              : "recoveryRequired"
            : "running"
      }
      if (group.phase === "cancelling" && group.candidates.every((c) => c.status === "cancelled"))
        group.phase = "cancelled"
      return snapshot()
    }),
  }
  const execution: jest.Mocked<BestOfNExecution> = {
    prepare: jest.fn(async (_group: BestOfNGroup, _input: BestOfNInput) => undefined),
    acquire: jest.fn(async (_g, c, _input: BestOfNInput) => ({
      bundleId: `b${c.index}`,
      physicalRoot: `/work/${c.index}`,
      workspaceId: `w${c.index}`,
    })),
    execute: jest.fn(async ({ candidate }) => ({
      changesetId: `change${candidate.index}`,
      headSha: `head${candidate.index}`,
      hasChanges: true,
      costUsd: null,
    })),
    stop: jest.fn(async (_group: BestOfNGroup) => undefined),
    finish: jest.fn(async (_group: BestOfNGroup) => undefined),
  }
  const service = createBestOfNService({ host, execution, ownerId: "owner" })
  return {
    input,
    host,
    execution,
    service,
    snapshot,
    change: (patch: Partial<BestOfNGroup>) => {
      group = { ...group, ...patch }
    },
  }
}
const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 0))
  expect(check()).toBe(true)
}

it("allocates once and dispatches exactly N independent attempts from the frozen base", async () => {
  const f = fixture()
  const [first, again] = await Promise.all([
    f.service.startBestOfN(f.input),
    f.service.startBestOfN(f.input),
  ])
  expect(first).toBe(again)
  expect((await first.completion).phase).toBe("awaitingSelection")
  expect(f.host.start).toHaveBeenCalledTimes(1)
  expect(f.execution.execute).toHaveBeenCalledTimes(2)
  for (const [call] of f.execution.execute.mock.calls) {
    expect(call.group.baseSha).toBe("frozen")
    expect(call.request.prompt).toBe(f.input.prompt)
    expect(call.grant.maxBudgetUsd).toBe(2)
    expect(call.grant.subagents).toEqual({ only: [] })
    expect(call.grant.model).toBe(call.candidate.agent.model)
  }
  expect(f.snapshot().candidates.every((c) => c.costUsd === null)).toBe(true)
})

it("keeps other attempts alive after one fails, including a no-change success", async () => {
  const f = fixture()
  f.execution.execute.mockImplementation(async ({ candidate }) => {
    if (candidate.index === 0) throw new Error("one failed")
    return { hasChanges: false, costUsd: null }
  })
  const result = await (await f.service.startBestOfN(f.input)).completion
  expect(result.phase).toBe("awaitingSelection")
  expect(result.candidates.map((c) => c.status)).toEqual(["failed", "succeeded"])
  expect(f.execution.stop).not.toHaveBeenCalled()
})

it("a later idempotent start returns current ledger state without resending", async () => {
  const f = fixture()
  await (
    await f.service.startBestOfN(f.input)
  ).completion
  f.change({ phase: "published", selectedCandidateId: "c0", selectedHeadSha: "head0" })
  const repeated = await f.service.startBestOfN(f.input)
  expect(repeated.group.phase).toBe("published")
  expect(f.execution.execute).toHaveBeenCalledTimes(2)
})

it("zero successful candidates requires recovery", async () => {
  const f = fixture()
  f.execution.execute.mockRejectedValue(new Error("failed"))
  expect((await (await f.service.startBestOfN(f.input)).completion).phase).toBe("recoveryRequired")
})

it("early human selection stops remaining attempts and preserves publishing", async () => {
  const f = fixture()
  f.execution.execute.mockImplementation(async ({ candidate, signal }) => {
    if (candidate.index === 0)
      return { hasChanges: true, costUsd: 1, changesetId: "change0", headSha: "head0" }
    return new Promise((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), { once: true })
    )
  })
  const handle = await f.service.startBestOfN(f.input)
  await until(
    () =>
      f.snapshot().candidates[0].status === "succeeded" &&
      f.execution.execute.mock.calls.length === 2
  )
  const selected = await f.service.select("group", "c0", "head0")
  expect(selected.phase).toBe("publishing")
  expect(selected.candidates[1].status).toBe("cancelled")
  expect((await handle.completion).selectedHeadSha).toBe("head0")
})

it.each([false, true])(
  "renews the lease during a slow confirmation (active sibling: %s)",
  async (activeSibling) => {
    jest.useFakeTimers()
    try {
      const f = fixture()
      f.input.budgetPolicy.maxDurationMs = 120_000
      if (activeSibling) {
        f.execution.execute.mockImplementation(async ({ candidate, signal }) => {
          if (candidate.index === 0)
            return { hasChanges: true, costUsd: 1, changesetId: "change0", headSha: "head0" }
          return new Promise((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), { once: true })
          )
        })
      }
      const handle = await f.service.startBestOfN(f.input)
      await jest.advanceTimersByTimeAsync(0)
      if (!activeSibling) await handle.completion
      const performSelect = f.host.select.getMockImplementation()!
      let confirm!: () => void
      f.host.select.mockImplementation(async (input) => {
        await new Promise<void>((resolve) => {
          confirm = resolve
        })
        if (f.snapshot().ownerLeaseExpiresAt <= Date.now()) throw new Error("lease expired")
        return performSelect(input)
      })
      const selected = f.service.select("group", "c0", "head0")
      await jest.advanceTimersByTimeAsync(0)
      const businessVersion = f.snapshot().version
      await jest.advanceTimersByTimeAsync(65_000)
      expect(f.snapshot().ownerLeaseExpiresAt).toBeGreaterThan(Date.now())
      expect(f.snapshot().version).toBe(businessVersion)
      if (activeSibling) expect(f.snapshot().candidates[1].status).toBe("running")
      confirm()
      expect((await selected).phase).toBe("publishing")
      await handle.completion
      expect(jest.getTimerCount()).toBe(0)
    } finally {
      jest.useRealTimers()
    }
  }
)

it("does not block candidate progress or retry stale native confirmation", async () => {
  const f = fixture()
  let finishSibling!: () => void
  f.execution.execute.mockImplementation(async ({ candidate }) => {
    if (candidate.index === 1)
      await new Promise<void>((resolve) => {
        finishSibling = resolve
      })
    return {
      hasChanges: true,
      costUsd: 1,
      changesetId: `change${candidate.index}`,
      headSha: `head${candidate.index}`,
    }
  })
  const handle = await f.service.startBestOfN(f.input)
  await until(() => f.snapshot().candidates[0].status === "succeeded" && Boolean(finishSibling))
  let confirm!: () => void
  f.host.select.mockImplementation(async ({ mutation }) => {
    await new Promise<void>((resolve) => {
      confirm = resolve
    })
    if (mutation.expectedVersion !== f.snapshot().version)
      throw new Error("best-of-N version conflict")
    return f.snapshot()
  })
  const selected = f.service.select("group", "c0", "head0")
  const rejected = expect(selected).rejects.toThrow("best-of-N version conflict")
  await until(() => Boolean(confirm))
  finishSibling()
  await until(() => f.snapshot().candidates[1].status === "succeeded")
  confirm()
  await rejected
  await handle.completion
  expect(f.host.select).toHaveBeenCalledTimes(1)
  expect(f.snapshot().selectedCandidateId).toBeNull()
})

it("cancel aborts all candidates and waits for terminal acknowledgements", async () => {
  const f = fixture()
  f.execution.execute.mockImplementation(
    async ({ signal }) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      )
  )
  await f.service.startBestOfN(f.input)
  await until(() => f.execution.execute.mock.calls.length === 2)
  expect((await f.service.cancel("group")).phase).toBe("cancelled")
})

it("recovery observes Host state and parks interrupted candidates without re-execution", async () => {
  const f = fixture()
  const state = f.snapshot()
  state.phase = "running"
  state.candidates[0].status = "running"
  f.change(state)
  expect((await f.service.recover("group")).phase).toBe("recoveryRequired")
  expect(f.execution.execute).not.toHaveBeenCalled()
  expect(f.host.progress).toHaveBeenCalledWith(
    expect.objectContaining({ status: "recoveryRequired" })
  )
})

it("a repeated request owned by another runtime only observes its ledger", async () => {
  const f = fixture()
  f.change({ ownerId: "other" })
  await (
    await f.service.startBestOfN(f.input)
  ).completion
  expect(f.execution.prepare).not.toHaveBeenCalled()
})

it.each(["cancelling", "publishing"] as const)(
  "recovery acknowledges stopped siblings after a restart during %s",
  async (phase) => {
    const f = fixture()
    const group = f.snapshot()
    group.phase = phase
    group.candidates.forEach((candidate) => (candidate.status = "cancelRequested"))
    f.change(group)
    const recovered = await f.service.recover(group.groupId)
    expect(f.execution.stop).toHaveBeenCalled()
    expect(recovered.candidates.every((candidate) => candidate.status === "cancelled")).toBe(true)
    expect(recovered.phase).toBe(phase === "cancelling" ? "cancelled" : "publishing")
    expect(f.execution.execute).not.toHaveBeenCalled()
  }
)

it("cancels a recovered allocation without a live renderer driver", async () => {
  const f = fixture()
  expect((await f.service.cancel("group")).phase).toBe("cancelled")
  expect(f.execution.execute).not.toHaveBeenCalled()
})

it("omits an unknown cost cap and preserves null cost", () => {
  const f = fixture()
  const group = f.snapshot()
  group.budgetPolicy.maxCostUsd = null
  expect(candidateGrant(group, group.candidates[0]).maxBudgetUsd).toBeUndefined()
})

it("bounds an in-flight attempt by the group duration", async () => {
  const f = fixture()
  f.input.budgetPolicy.maxDurationMs = 30
  f.execution.execute.mockImplementation(
    async ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      })
  )
  const result = await (await f.service.startBestOfN(f.input)).completion
  expect(result.candidates.every((c) => c.status === "cancelled")).toBe(true)
  expect(f.execution.stop).toHaveBeenCalled()
})

it("persists preparation failure instead of leaving an orphan preparing group", async () => {
  const f = fixture()
  f.execution.prepare.mockRejectedValue(new Error("prepare unavailable"))
  await expect((await f.service.startBestOfN(f.input)).completion).rejects.toThrow(
    "prepare unavailable"
  )
  expect(f.snapshot().phase).toBe("recoveryRequired")
  expect(f.execution.execute).not.toHaveBeenCalled()
})

it("retries a CAS collision without dispatching another attempt", async () => {
  const f = fixture()
  f.host.progress.mockRejectedValueOnce(new Error("best-of-N version conflict"))
  await (
    await f.service.startBestOfN(f.input)
  ).completion
  expect(f.execution.execute).toHaveBeenCalledTimes(2)
})

it("keeps known spend on a failed attempt", async () => {
  const f = fixture()
  f.execution.execute.mockRejectedValue(new BestOfNAttemptError("budget exceeded", 2))
  const result = await (await f.service.startBestOfN(f.input)).completion
  expect(result.candidates.map((c) => c.costUsd)).toEqual([2, 2])
})

it("denies actual collaboration, shared-memory and fan-out tool names", () => {
  const f = fixture()
  const group = f.snapshot()
  expect(candidateGrant(group, group.candidates[0]).tools?.deny).toEqual(
    expect.arrayContaining([
      "spawn_task",
      "team_send_message",
      "team_delegate",
      "team_read_memory",
      "list_sessions",
      "send_session_message",
      "vector_add_document",
    ])
  )
})
