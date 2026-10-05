/**
 * The durable coordinator against the reference memory store and fake host
 * ports (ADR-0217). The app suite (`durable-runtime.test.ts`) covers the
 * app's bindings: Dexie, the execution-run journal, `@cognia/redact`, the
 * app's path semantics and the fleet session projection.
 */

import {
  createDurableTeamCoordinator,
  type DurableTeamCoordinator,
  type DurableTeamCoordinatorOptions,
  type DurableTeamSpec,
  type TeamPathPolicy,
} from "./coordinator"
import { createMemoryTeamRunStore } from "./memory-store"
import type { TeamRunStore } from "./store"

/** POSIX path semantics: absolute paths only, `..` resolved, never above `/`. */
function normalizePosix(path: string): string {
  if (!path.startsWith("/")) return ""
  const parts: string[] = []
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue
    if (segment === "..") {
      if (parts.length === 0) return ""
      parts.pop()
    } else parts.push(segment)
  }
  return `/${parts.join("/")}`
}

const posixPaths: TeamPathPolicy = {
  normalize: normalizePosix,
  isWithinRoot(target, root) {
    const t = normalizePosix(target)
    const r = normalizePosix(root)
    if (!t || !r) return false
    return r === "/" || t === r || t.startsWith(`${r}/`)
  },
}

const spec = (overrides: Partial<DurableTeamSpec> = {}): DurableTeamSpec => ({
  id: "team-1",
  leadId: "lead-1",
  projectId: "project-1",
  objective: "Ship",
  writeMode: "single-writer",
  repositories: [
    { id: "primary", role: "primary", path: "/repo", writable: true },
    { id: "dep", role: "dependency", path: "/dep", writable: true },
  ],
  resourcePolicy: { priority: 2, maxConcurrentChildren: 2 },
  maxConcurrentTeammates: 2,
  ...overrides,
})

describe("durable AgentTeam coordinator", () => {
  let store: TeamRunStore
  const journal = { runPrepared: jest.fn(async () => undefined) }
  const releaseRemoteSession = jest.fn(async (_remoteSessionId: string) => undefined)
  const make = (overrides: Partial<DurableTeamCoordinatorOptions> = {}) =>
    createDurableTeamCoordinator({
      store,
      journal,
      redactForPersistence: (text) => text.replace(/[\w.+-]+@[\w.-]+\.\w+/g, "[EMAIL]"),
      paths: posixPaths,
      remoteSessions: { release: releaseRemoteSession },
      ...overrides,
    })

  beforeEach(() => {
    store = createMemoryTeamRunStore()
    journal.runPrepared.mockClear()
    releaseRemoteSession.mockClear()
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  const register = async (coordinator: DurableTeamCoordinator, childRunId: string) =>
    coordinator.registerChild({
      runId: "run-admission",
      childRunId,
      teammateId: childRunId,
      taskId: childRunId,
      repositoryId: "primary",
      access: "read",
    })

  const waitUntil = async (ready: () => boolean): Promise<void> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (ready()) return
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    throw new Error("Condition did not settle")
  }

  it("keeps terminal children terminal during recovery even without checkpoints", async () => {
    const coordinator = make()
    await coordinator.prepareRun(spec(), "run-admission")
    for (const status of ["completed", "failed", "cancelled", "terminated"] as const) {
      await register(coordinator, status)
      await store.updateChild(status, { status })
    }
    const recovered = await coordinator.recover()
    expect(recovered).toEqual([{ runId: "run-admission", status: "recovering" }])
    for (const status of ["completed", "failed", "cancelled", "terminated"] as const) {
      expect((await store.getChild(status))?.status).toBe(status)
    }
  })

  it("gates remote events persisted after the latest safe checkpoint", async () => {
    const coordinator = make()
    await coordinator.prepareRun(spec(), "run-admission")
    await register(coordinator, "remote")
    await coordinator.checkpoint("remote", {
      trajectorySequence: 1,
      replay: "safe",
      sideEffects: [],
    })
    await store.appendTrajectory({
      runId: "run-admission",
      childRunId: "remote",
      kind: "remote_event",
      correlationId: "event-after-checkpoint",
      createdAt: Date.now(),
    })
    expect(await coordinator.recover()).toEqual([{ runId: "run-admission", status: "needs_input" }])
    expect((await store.getChild("remote"))?.status).toBe("needs_input")
  })

  it("does not recover a run terminated after the recovery scan", async () => {
    const coordinator = make()
    await coordinator.prepareRun(spec(), "run-admission")
    await register(coordinator, "child")
    const list = store.listRecoveryCandidates
    jest.spyOn(store, "listRecoveryCandidates").mockImplementationOnce(async () => {
      const candidates = await list()
      await store.updateRun("run-admission", { status: "terminated" })
      return candidates
    })
    expect(await coordinator.recover()).toEqual([])
    expect((await store.getRun("run-admission"))?.status).toBe("terminated")
    expect((await store.getChild("child"))?.status).toBe("running")
  })

  it("does not replace a terminated run with the budget input gate", async () => {
    const coordinator = make()
    await coordinator.prepareRun(
      spec({
        resourcePolicy: { priority: 0, maxConcurrentChildren: 1, maxTokens: 0 },
      }),
      "run-admission"
    )
    await register(coordinator, "child")
    const getRun = store.getRun
    jest.spyOn(store, "getRun").mockImplementationOnce(async (id) => {
      const run = await getRun(id)
      await store.updateRun(id, { status: "terminated" })
      return run
    })
    const operation = jest.fn()
    await expect(coordinator.withChildAdmission("child", operation)).rejects.toThrow("budget")
    expect((await store.getRun("run-admission"))?.status).toBe("terminated")
    expect((await store.getChild("child"))?.status).toBe("running")
    expect(operation).not.toHaveBeenCalled()
    expect(coordinator.schedulerSnapshot()).toEqual({ queued: [], active: [] })
  })

  it("does not start a queued run cancelled while preparation reads it", async () => {
    const coordinator = make()
    await coordinator.prepareRun(spec(), "run-admission")
    await store.updateRun("run-admission", { status: "queued" })
    const getRun = store.getRun
    jest.spyOn(store, "getRun").mockImplementationOnce(async (id) => {
      const run = await getRun(id)
      await store.updateRun(id, { status: "cancelled" })
      return run
    })
    await expect(coordinator.prepareRun(spec(), "run-admission")).rejects.toThrow("changed")
    expect((await store.getRun("run-admission"))?.status).toBe("cancelled")
  })

  it.each(["completed", "failed", "cancelled", "terminated"] as const)(
    "does not revive a %s child through sleep or wake",
    async (status) => {
      const coordinator = make()
      await coordinator.prepareRun(spec(), "run-admission")
      await register(coordinator, "child")
      await store.updateChild("child", { status })
      const resume = jest.fn(async () => undefined)
      coordinator.attachLiveControl("child", { steer: jest.fn(), resume })
      await coordinator.sleepChild("child")
      await coordinator.wakeChild("child")
      expect((await store.getChild("child"))?.status).toBe(status)
      expect(resume).not.toHaveBeenCalled()
    }
  )

  it("does not revive a child that terminates while wake waits for the provider", async () => {
    const coordinator = make()
    await coordinator.prepareRun(spec(), "run-admission")
    await register(coordinator, "child")
    await coordinator.sleepChild("child")
    coordinator.attachLiveControl("child", {
      steer: jest.fn(),
      resume: async () => {
        await store.updateChild("child", { status: "terminated" })
      },
    })
    await coordinator.wakeChild("child")
    expect((await store.getChild("child"))?.status).toBe("terminated")
  })

  it("rejects remote resume and cross-host migration after uncheckpointed remote work", async () => {
    const coordinator = make()
    await coordinator.prepareRun(spec(), "run-admission")
    await register(coordinator, "child")
    await store.updateChild("child", {
      hostRef: "device:a",
      remoteSessionId: "remote-session",
      status: "paused",
    })
    await coordinator.checkpoint("child", {
      trajectorySequence: 1,
      replay: "safe",
      sideEffects: [],
    })
    await store.appendTrajectory({
      runId: "run-admission",
      childRunId: "child",
      kind: "remote_event",
      correlationId: "uncheckpointed-command",
      createdAt: Date.now(),
    })
    await expect(coordinator.resumeChild("child")).rejects.toThrow("safe checkpoint")
    await expect(coordinator.retryChild("child", "device:b")).rejects.toThrow("safe checkpoint")
    expect((await store.getChild("child"))?.status).toBe("paused")
  })

  it.each(["completed", "failed", "cancelled", "terminated"] as const)(
    "refuses child retry for a %s parent",
    async (status) => {
      const coordinator = make()
      await coordinator.prepareRun(spec(), "run-admission")
      await register(coordinator, "child")
      await store.updateChild("child", { status: "failed" })
      await store.updateRun("run-admission", { status })
      await expect(coordinator.retryChild("child")).rejects.toThrow("cannot be retried")
      expect((await store.getRun("run-admission"))?.status).toBe(status)
    }
  )

  it("rejects duplicate admission for the same child while the first holds capacity", async () => {
    const coordinator = make()
    await coordinator.prepareRun(spec(), "run-admission")
    await register(coordinator, "first")
    let release!: () => void
    const first = coordinator.withChildAdmission(
      "first",
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    await waitUntil(() => !!release)
    await expect(coordinator.withChildAdmission("first", jest.fn())).rejects.toThrow(
      "already has an admission"
    )
    expect(coordinator.schedulerSnapshot().active).toHaveLength(1)
    release()
    await first
  })

  it("cancels admission parked on a paused run", async () => {
    const coordinator = make()
    await coordinator.prepareRun(spec(), "run-admission")
    await register(coordinator, "first")
    coordinator.setRunPaused("run-admission", true)
    const controller = new AbortController()
    const operation = jest.fn()
    const waiting = coordinator.withChildAdmission("first", operation, controller.signal)
    const rejected = expect(waiting).rejects.toThrow("cancel parked")
    await new Promise((resolve) => setTimeout(resolve, 5))
    controller.abort(new Error("cancel parked"))
    await rejected
    coordinator.setRunPaused("run-admission", false)
    expect(operation).not.toHaveBeenCalled()
    expect(coordinator.schedulerSnapshot()).toEqual({ queued: [], active: [] })
  })

  it.each(["terminateChild", "pauseChild"] as const)(
    "does not execute queued work after %s",
    async (action) => {
      const coordinator = make({ globalConcurrency: 1 })
      await coordinator.prepareRun(spec(), "run-admission")
      await register(coordinator, "first")
      await register(coordinator, "second")
      let release!: () => void
      const first = coordinator.withChildAdmission(
        "first",
        () =>
          new Promise<void>((resolve) => {
            release = resolve
          })
      )
      await waitUntil(() => !!release)
      const operation = jest.fn()
      const second = coordinator.withChildAdmission("second", operation)
      const rejected = expect(second).rejects.toThrow()
      await waitUntil(() => coordinator.schedulerSnapshot().queued.length === 1)
      await coordinator[action]("second")
      release()
      await first
      await rejected
      expect(operation).not.toHaveBeenCalled()
      expect((await store.getChild("second"))?.status).toBe(
        action === "terminateChild" ? "terminated" : "paused"
      )
      expect(coordinator.schedulerSnapshot()).toEqual({ queued: [], active: [] })
    }
  )

  it("releases admission when the running-state write fails", async () => {
    const coordinator = make({ globalConcurrency: 1 })
    await coordinator.prepareRun(spec(), "run-admission")
    await register(coordinator, "first")
    const update = store.updateChildIfCurrent
    jest.spyOn(store, "updateChildIfCurrent").mockImplementation(async (id, expected, patch) => {
      if (patch.status === "running") throw new Error("injected store failure")
      return update(id, expected, patch)
    })
    await expect(coordinator.withChildAdmission("first", jest.fn())).rejects.toThrow(
      "injected store failure"
    )
    expect(coordinator.schedulerSnapshot()).toEqual({ queued: [], active: [] })
  })

  it("cancels queued admission without waiting for the active child", async () => {
    const coordinator = make({ globalConcurrency: 1 })
    await coordinator.prepareRun(spec(), "run-admission")
    await register(coordinator, "first")
    await register(coordinator, "second")
    let release!: () => void
    const first = coordinator.withChildAdmission(
      "first",
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    await waitUntil(() => !!release)
    const controller = new AbortController()
    const second = coordinator.withChildAdmission("second", jest.fn(), controller.signal)
    const rejected = expect(second).rejects.toThrow("cancel queued")
    await waitUntil(() => coordinator.schedulerSnapshot().queued.length === 1)
    controller.abort(new Error("cancel queued"))
    await rejected
    expect(coordinator.schedulerSnapshot().queued).toHaveLength(0)
    release()
    await first
  })

  it("retains active capacity until cancelled work settles and rejects its late result", async () => {
    const coordinator = make({ globalConcurrency: 1 })
    await coordinator.prepareRun(spec(), "run-admission")
    await register(coordinator, "first")
    await register(coordinator, "second")
    let release!: () => void
    const controller = new AbortController()
    const first = coordinator.withChildAdmission(
      "first",
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve("late success")
        }),
      controller.signal
    )
    const rejected = expect(first).rejects.toThrow("cancel active")
    await waitUntil(() => !!release)
    controller.abort(new Error("cancel active"))
    const operation = jest.fn()
    const second = coordinator.withChildAdmission("second", operation)
    await waitUntil(() => coordinator.schedulerSnapshot().queued.length === 1)
    expect(coordinator.schedulerSnapshot().active).toHaveLength(1)
    expect(operation).not.toHaveBeenCalled()
    release()
    await Promise.all([rejected, second])
    expect(operation).toHaveBeenCalledTimes(1)
    expect(coordinator.schedulerSnapshot()).toEqual({ queued: [], active: [] })
  })

  it("cancels a writer wait without releasing the preceding writer lease", async () => {
    const coordinator = make()
    await coordinator.prepareRun(spec(), "run-admission")
    const request = { runId: "run-admission", repositoryId: "primary", access: "write" as const }
    let release!: () => void
    const first = coordinator.withWorkspaceLease(
      request,
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    await waitUntil(() => !!release)
    const controller = new AbortController()
    const skipped = jest.fn()
    const second = coordinator.withWorkspaceLease(request, skipped, controller.signal)
    const rejected = expect(second).rejects.toThrow("cancel writer")
    const thirdOperation = jest.fn()
    const third = coordinator.withWorkspaceLease(request, thirdOperation)
    controller.abort(new Error("cancel writer"))
    await rejected
    expect(skipped).not.toHaveBeenCalled()
    expect(thirdOperation).not.toHaveBeenCalled()
    release()
    await Promise.all([first, third])
    expect(thirdOperation).toHaveBeenCalledTimes(1)
  })

  it.each(["mutation", "alias", "root"])(
    "keeps isolated writer ownership exclusive across %s",
    async (scenario) => {
      const coordinator = make()
      await coordinator.prepareRun(spec({ writeMode: "isolated-parallel" }), "run-admission")
      const ownership = [
        scenario === "alias" ? "src/../shared" : scenario === "root" ? "." : "shared",
      ]
      const request = {
        runId: "run-admission",
        repositoryId: "primary",
        access: "write" as const,
        fileOwnership: ownership,
      }
      let release!: () => void
      const active = coordinator.withWorkspaceLease(
        request,
        () =>
          new Promise<void>((resolve) => {
            release = resolve
          })
      )
      await waitUntil(() => !!release)
      if (scenario === "mutation") ownership[0] = "unrelated"
      const operation = jest.fn()
      try {
        await expect(
          coordinator.withWorkspaceLease(
            { ...request, fileOwnership: ["shared/file.ts"] },
            operation
          )
        ).rejects.toThrow("overlaps")
        expect(operation).not.toHaveBeenCalled()
      } finally {
        release()
        await active
      }
      await coordinator.withWorkspaceLease(
        { ...request, fileOwnership: ["shared/file.ts"] },
        operation
      )
      expect(operation).toHaveBeenCalledTimes(1)
    }
  )

  it("coalesces concurrent wake requests into one provider resume", async () => {
    const coordinator = make()
    await coordinator.prepareRun(spec(), "run-admission")
    await register(coordinator, "child")
    await coordinator.sleepChild("child")
    let release!: () => void
    const resumed = new Promise<void>((resolve) => {
      release = resolve
    })
    const resume = jest.fn(() => resumed)
    coordinator.attachLiveControl("child", { steer: jest.fn(), resume })
    const first = coordinator.wakeChild("child")
    const second = coordinator.wakeChild("child")
    await waitUntil(() => resume.mock.calls.length > 0)
    release()
    await Promise.all([first, second])
    expect(resume).toHaveBeenCalledTimes(1)
    await coordinator.wakeChild("child")
    expect(resume).toHaveBeenCalledTimes(1)
  })

  it("reuses the remote checkpoint gate when waking a sleeping child", async () => {
    const coordinator = make()
    await coordinator.prepareRun(spec(), "run-admission")
    await register(coordinator, "child")
    await coordinator.sleepChild("child")
    await store.updateChild("child", { remoteSessionId: "remote" })
    const resume = jest.fn(async () => undefined)
    coordinator.attachLiveControl("child", { steer: jest.fn(), resume })
    await expect(coordinator.wakeChild("child")).rejects.toThrow("safe checkpoint")
    expect(resume).not.toHaveBeenCalled()
    expect(await store.getChild("child")).toMatchObject({ status: "sleeping" })
    await coordinator.checkpoint("child", {
      replay: "safe",
      sideEffects: [],
      trajectorySequence: 1,
    })
    await coordinator.wakeChild("child")
    expect(await store.getChild("child")).toMatchObject({ status: "queued" })
  })

  it("does not wake a sleeping child after its parent terminates", async () => {
    const coordinator = make()
    await coordinator.prepareRun(spec(), "run-admission")
    await register(coordinator, "child")
    await coordinator.sleepChild("child")
    await store.updateRun("run-admission", { status: "terminated" })
    const resume = jest.fn(async () => undefined)
    coordinator.attachLiveControl("child", { steer: jest.fn(), resume })
    await expect(coordinator.wakeChild("child")).rejects.toThrow("run stopped")
    expect(resume).not.toHaveBeenCalled()
  })

  it("keeps a newer pause when a concurrent wake finishes later", async () => {
    const coordinator = make()
    await coordinator.prepareRun(spec(), "run-admission")
    await register(coordinator, "child")
    await coordinator.sleepChild("child")
    let release!: () => void
    coordinator.attachLiveControl("child", {
      steer: jest.fn(),
      resume: () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
      pause: async () => true,
    })
    const wake = coordinator.wakeChild("child")
    await waitUntil(() => !!release)
    await coordinator.pauseChild("child")
    release()
    await wake
    expect(await store.getChild("child")).toMatchObject({ status: "paused" })
  })

  it("rejects ambiguous repository topology before creating a run", async () => {
    const coordinator = make({ now: () => 100 })
    const invalid = spec({
      repositories: [
        { id: "one", role: "primary", path: "/one", writable: true },
        { id: "two", role: "primary", path: "/two", writable: true },
      ],
    })

    await expect(coordinator.prepareRun(invalid, "run-invalid")).rejects.toThrow(
      /exactly one primary repository/
    )
    expect(await store.listRuns()).toEqual([])
  })

  it("snapshots configured operator constraints into the immutable run ledger", async () => {
    const coordinator = make({ now: () => 90 })
    await coordinator.prepareRun(
      spec({
        userConstraints: [{ title: "Compatibility", detail: "Do not break the public API" }],
      }),
      "run-constraints"
    )

    expect(await store.listDecisions("run-constraints")).toEqual([
      expect.objectContaining({
        status: "constraint",
        immutable: true,
        title: "Compatibility",
        detail: "Do not break the public API",
      }),
    ])
    expect(journal.runPrepared).toHaveBeenCalledWith({
      runId: "run-constraints",
      projectId: "project-1",
      title: "Ship",
      at: 90,
    })
  })

  it("serializes writers while allowing read-only work to proceed", async () => {
    const coordinator = make({ now: () => 100 })
    await coordinator.prepareRun(spec(), "run-1")
    const order: string[] = []
    let releaseFirst!: () => void
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const first = coordinator.withWorkspaceLease(
      { runId: "run-1", repositoryId: "primary", access: "write" },
      async () => {
        order.push("writer-1:start")
        await firstBlocked
        order.push("writer-1:end")
      }
    )
    const second = coordinator.withWorkspaceLease(
      { runId: "run-1", repositoryId: "primary", access: "write" },
      async () => order.push("writer-2")
    )
    const reader = coordinator.withWorkspaceLease(
      { runId: "run-1", repositoryId: "primary", access: "read" },
      async () => order.push("reader")
    )

    await reader
    expect(order).toEqual(["writer-1:start", "reader"])
    releaseFirst()
    await Promise.all([first, second])
    expect(order).toEqual(["writer-1:start", "reader", "writer-1:end", "writer-2"])
  })

  it("delivers live steering and queues a durable fallback when live control fails", async () => {
    const coordinator = make({ now: () => 200 })
    await coordinator.prepareRun(spec(), "run-2")
    await coordinator.registerChild({
      runId: "run-2",
      childRunId: "child-1",
      teammateId: "mate-1",
      taskId: "task-1",
      repositoryId: "primary",
      access: "write",
    })
    const steer = jest.fn(async () => undefined)
    coordinator.attachLiveControl("child-1", { steer })

    const delivered = await coordinator.steer("child-1", "Check tests")
    expect(delivered.status).toBe("delivered")
    expect(steer).toHaveBeenCalledWith("Check tests", delivered.id)

    coordinator.attachLiveControl("child-1", {
      steer: async () => {
        throw new Error("no active turn")
      },
    })
    const queued = await coordinator.steer("child-1", "Inspect migration")
    expect(queued.status).toBe("queued")
    expect(
      (await store.listSteeringReceipts("run-2")).filter((row) => row.status === "queued")
    ).toHaveLength(1)
  })

  it("sends the PII-gated steering payload to the live runtime", async () => {
    const coordinator = make({ now: () => 225 })
    await coordinator.prepareRun(spec(), "run-redacted-steer")
    await coordinator.registerChild({
      runId: "run-redacted-steer",
      childRunId: "child-redacted-steer",
      teammateId: "mate-1",
      taskId: "task-redacted-steer",
      repositoryId: "primary",
      access: "read",
    })
    const steer = jest.fn(async () => undefined)
    coordinator.attachLiveControl("child-redacted-steer", { steer })

    const receipt = await coordinator.steer(
      "child-redacted-steer",
      "Contact operator@example.com before continuing"
    )

    expect(receipt.message).toBe("Contact [EMAIL] before continuing")
    expect(steer).toHaveBeenCalledWith(receipt.message, receipt.id)
  })

  it("refuses steering and takeover text the host's redactor will not clear", async () => {
    const coordinator = make({ now: () => 230, redactForPersistence: () => undefined })
    await coordinator.prepareRun(spec(), "run-refused")
    await coordinator.registerChild({
      runId: "run-refused",
      childRunId: "child-refused",
      teammateId: "mate-1",
      taskId: "task-refused",
      repositoryId: "primary",
      access: "read",
    })
    const steer = jest.fn(async () => undefined)
    coordinator.attachLiveControl("child-refused", { steer })
    await expect(coordinator.steer("child-refused", "anything")).rejects.toThrow(/PII/)
    expect(steer).not.toHaveBeenCalled()
    expect(await store.listSteeringReceipts("run-refused")).toEqual([])
    await expect(
      coordinator.completeTakeover({ childRunId: "child-refused", commands: ["ls"] })
    ).rejects.toThrow(/PII redaction/)
    expect(await store.listEvidence("run-refused")).toEqual([])
  })

  it("rejects isolated ownership that escapes the repository before execution", async () => {
    const coordinator = make()
    await coordinator.prepareRun(spec({ writeMode: "isolated-parallel" }), "run-admission")
    for (const path of ["", "../outside", "/outside", "src\0file"]) {
      const operation = jest.fn()
      await expect(
        coordinator.withWorkspaceLease(
          {
            runId: "run-admission",
            repositoryId: "primary",
            access: "write",
            fileOwnership: [path],
          },
          operation
        )
      ).rejects.toThrow(/ownership/)
      expect(operation).not.toHaveBeenCalled()
    }
  })

  it("forwards pause, resume, and terminate requests to the active provider control", async () => {
    const coordinator = make({ now: () => 250 })
    await coordinator.prepareRun(spec(), "run-control")
    await coordinator.registerChild({
      runId: "run-control",
      childRunId: "child-control",
      teammateId: "mate-1",
      taskId: "task-control",
      repositoryId: "primary",
      access: "write",
    })
    const pause = jest.fn(async () => undefined)
    const resume = jest.fn(async () => undefined)
    const terminate = jest.fn(async () => undefined)
    coordinator.attachLiveControl("child-control", {
      steer: async () => undefined,
      pause,
      resume,
      terminate,
    })

    await coordinator.pauseChild("child-control")
    await coordinator.resumeChild("child-control")
    await store.updateChild("child-control", {
      remoteSessionId: "remote-control",
    })
    await coordinator.terminateChild("child-control")

    expect(pause).toHaveBeenCalledTimes(1)
    expect(resume).toHaveBeenCalledTimes(1)
    expect(terminate).toHaveBeenCalledTimes(1)
    expect(releaseRemoteSession).toHaveBeenCalledWith("remote-control")
    expect((await store.getChild("child-control"))?.status).toBe("terminated")
  })

  it("recovers safe checkpoints and gates uncertain side effects", async () => {
    const coordinator = make({ now: () => 300 })
    await coordinator.prepareRun(spec(), "run-safe")
    await coordinator.registerChild({
      runId: "run-safe",
      childRunId: "child-safe",
      teammateId: "mate-1",
      taskId: "task-safe",
      repositoryId: "primary",
      access: "write",
    })
    await coordinator.checkpoint("child-safe", {
      replay: "safe",
      sideEffects: [],
      trajectorySequence: 0,
    })

    await coordinator.prepareRun(spec(), "run-uncertain")
    await coordinator.registerChild({
      runId: "run-uncertain",
      childRunId: "child-uncertain",
      teammateId: "mate-1",
      taskId: "task-uncertain",
      repositoryId: "primary",
      access: "write",
    })
    await coordinator.checkpoint("child-uncertain", {
      replay: "needs_input",
      trajectorySequence: 0,
      sideEffects: [{ id: "publish", kind: "github_pr", state: "unknown", replay: "unknown" }],
    })

    const recovered = await coordinator.recover()
    expect(recovered).toEqual(
      expect.arrayContaining([
        { runId: "run-safe", status: "recovering" },
        { runId: "run-uncertain", status: "needs_input" },
      ])
    )
  })

  it("retries on the same host but requires a safe checkpoint to migrate", async () => {
    let now = 500
    const coordinator = make({ now: () => now })
    await coordinator.prepareRun(spec(), "run-retry")
    await coordinator.registerChild({
      runId: "run-retry",
      childRunId: "child-retry",
      teammateId: "mate-1",
      taskId: "task-1",
      repositoryId: "primary",
      access: "write",
    })
    await store.updateChild("child-retry", {
      hostRef: "device:a",
      status: "needs_input",
      dispatchLeaseId: "dispatch:old-attempt",
      dispatchLeaseExpiresAt: 60_000,
    })

    await expect(coordinator.retryChild("child-retry", "device:b")).rejects.toThrow(
      "Cross-host retry requires a safe checkpoint"
    )
    const sameHost = await coordinator.retryChild("child-retry", "device:a")
    expect(sameHost).toMatchObject({
      status: "queued",
      waitingReason: "retry_host:device:a",
    })
    expect(sameHost.dispatchLeaseId).toBeUndefined()
    expect(sameHost.dispatchLeaseExpiresAt).toBeUndefined()

    now = 550
    await coordinator.checkpoint("child-retry", {
      trajectorySequence: 0,
      replay: "safe",
      sideEffects: [],
    })
    const migrated = await coordinator.retryChild("child-retry", "device:b")
    expect(migrated.waitingReason).toBe("retry_host:device:b")
    expect((await store.getRun("run-retry"))?.status).toBe("recovering")
  })

  it("requeues a remote child from a safe checkpoint without reopening its old session", async () => {
    const coordinator = make({ now: () => 1_000 })
    await coordinator.prepareRun(spec(), "run-remote-resume")
    await coordinator.registerChild({
      runId: "run-remote-resume",
      childRunId: "child-remote-resume",
      teammateId: "mate-1",
      taskId: "task-1",
      repositoryId: "primary",
      access: "read",
    })
    await store.updateChild("child-remote-resume", {
      remoteSessionId: "remote-session-1",
      attempt: 1,
    })
    const resume = jest.fn(async () => undefined)
    coordinator.attachLiveControl("child-remote-resume", {
      steer: jest.fn(async () => undefined),
      resume,
    })

    await expect(coordinator.resumeChild("child-remote-resume")).rejects.toThrow("safe checkpoint")
    await coordinator.checkpoint("child-remote-resume", {
      trajectorySequence: 0,
      replay: "safe",
      sideEffects: [],
    })
    await coordinator.resumeChild("child-remote-resume")

    expect(resume).not.toHaveBeenCalled()
    expect(await store.getChild("child-remote-resume")).toMatchObject({
      status: "queued",
      attempt: 1,
    })
    expect((await store.getChild("child-remote-resume"))?.remoteSessionId).toBeUndefined()
  })

  it("does not overwrite a terminal child that settles while pause waits for idle", async () => {
    const coordinator = make({ now: () => 1_100 })
    await coordinator.prepareRun(spec(), "run-pause-race")
    await coordinator.registerChild({
      runId: "run-pause-race",
      childRunId: "child-pause-race",
      teammateId: "mate-1",
      taskId: "task-1",
      repositoryId: "primary",
      access: "read",
    })
    coordinator.attachLiveControl("child-pause-race", {
      steer: jest.fn(async () => undefined),
      pause: async () => {
        await store.updateChild("child-pause-race", { status: "completed" })
        return true
      },
    })

    await coordinator.pauseChild("child-pause-race")
    expect((await store.getChild("child-pause-race"))?.status).toBe("completed")
  })

  it("routes an unsafe cooperative pause to needs_input", async () => {
    const coordinator = make({ now: () => 1_200 })
    await coordinator.prepareRun(spec(), "run-pause-unsafe")
    await coordinator.registerChild({
      runId: "run-pause-unsafe",
      childRunId: "child-pause-unsafe",
      teammateId: "mate-1",
      taskId: "task-1",
      repositoryId: "primary",
      access: "read",
    })
    coordinator.attachLiveControl("child-pause-unsafe", {
      steer: jest.fn(async () => undefined),
      pause: jest.fn(async () => false),
    })

    await coordinator.pauseChild("child-pause-unsafe")
    expect((await store.getChild("child-pause-unsafe"))?.status).toBe("needs_input")
  })

  it("blocks new child admission while a cooperative pause waits for idle", async () => {
    const coordinator = make({ now: () => 1_300 })
    await coordinator.prepareRun(spec(), "run-pause-admission")
    await coordinator.registerChild({
      runId: "run-pause-admission",
      childRunId: "child-pause-admission",
      teammateId: "mate-1",
      taskId: "task-1",
      repositoryId: "primary",
      access: "read",
    })
    let releasePause!: () => void
    coordinator.attachLiveControl("child-pause-admission", {
      steer: jest.fn(async () => undefined),
      pause: () => new Promise<boolean>((resolve) => (releasePause = () => resolve(true))),
    })

    const pausing = coordinator.pauseChild("child-pause-admission")
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect((await store.getChild("child-pause-admission"))?.status).toBe("pausing")
    await expect(
      coordinator.withChildAdmission("child-pause-admission", async () => undefined)
    ).rejects.toThrow("not accepting new turns")
    releasePause()
    await pausing
    expect((await store.getChild("child-pause-admission"))?.status).toBe("paused")
  })

  it("falls back to the working directory as the only writable primary repository", async () => {
    const coordinator = make()
    await coordinator.prepareRun(spec({ repositories: [], workingDir: "/work" }), "run-workdir")
    await expect(
      coordinator.registerChild({
        runId: "run-workdir",
        childRunId: "child",
        teammateId: "mate-1",
        taskId: "task-1",
        repositoryId: "primary",
        access: "write",
      })
    ).resolves.toMatchObject({ repositoryId: "primary" })
    await expect(
      make().prepareRun(spec({ repositories: [], workingDir: undefined }), "run-none")
    ).rejects.toThrow(/exactly one primary repository/)
  })

  it("completes a manual takeover with redacted evidence, a safe checkpoint and a resume", async () => {
    const coordinator = make({ now: () => 1_400 })
    await coordinator.prepareRun(spec(), "run-takeover")
    await coordinator.registerChild({
      runId: "run-takeover",
      childRunId: "child-takeover",
      teammateId: "mate-1",
      taskId: "task-1",
      repositoryId: "primary",
      access: "write",
    })
    const pause = jest.fn(async () => true)
    const resume = jest.fn(async () => undefined)
    coordinator.attachLiveControl("child-takeover", { steer: jest.fn(), pause, resume })

    const taken = await coordinator.beginTakeover("child-takeover")
    expect(taken.status).toBe("paused")
    await coordinator.completeTakeover({
      childRunId: "child-takeover",
      commands: ["notify ops@example.com"],
      diffContent: "diff --git a/x b/x",
      workspaceCommit: "abc123",
    })

    const evidence = await store.listEvidence("run-takeover", { childRunId: "child-takeover" })
    expect(evidence.map((item) => item.kind)).toEqual(["command", "diff", "commit"])
    const command = await store.getContent(evidence[0].contentHash!)
    expect(new TextDecoder().decode(command?.data)).toBe("notify [EMAIL]")
    expect(await store.getLatestCheckpoint("child-takeover")).toMatchObject({
      replay: "safe",
      workspaceCommit: "abc123",
    })
    expect((await store.listTrajectory("run-takeover")).map((event) => event.kind)).toEqual(
      expect.arrayContaining(["manual_takeover_started", "manual_takeover_completed"])
    )
    expect(resume).toHaveBeenCalledTimes(1)
    expect((await store.getChild("child-takeover"))?.status).toBe("queued")
  })
})
