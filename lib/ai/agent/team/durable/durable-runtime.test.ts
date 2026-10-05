import "fake-indexeddb/auto"

import { __enableDbRuntimeForTesting, __resetDbForTesting, getDb } from "@/lib/db/schema"
import { runEventJournal } from "@/lib/db/execution-runs"
import type { AgentTeam, AgentTeamConfig } from "@/types/agent/agent-team"
import {
  __resetDurableTeamCoordinatorForTesting,
  createDurableTeamCoordinator,
  durableTeamSpec,
  getDurableTeamCoordinator,
  isDurableChildReplaySafe,
  redactTeamTextForPersistence,
} from "./durable-runtime"
import * as runtimeDb from "@/lib/db/agent-team-runtime"

// The coordinator's own behavior is covered against the memory store in
// `@cognia/agent-orchestration` (coordinator.test.ts). This suite covers the
// app's bindings: Dexie, the execution-run journal, `@cognia/redact`, the
// app's path semantics, the fleet session projection and the team mapping.

const removeManagedFleetSession = jest.fn<Promise<boolean>, [sessionId: string]>(async () => true)
jest.mock("@/lib/fleet/managed-session-projection", () => ({
  removeManagedFleetSession: (sessionId: string) => removeManagedFleetSession(sessionId),
}))

const mockLeakCheck = jest.fn<boolean | undefined, [string]>(() => undefined)
jest.mock("@cognia/redact", () => {
  const actual = jest.requireActual("@cognia/redact")
  return {
    ...actual,
    // `undefined` defers to the real check; a test forces a verdict.
    hasNoLeakingPii: (text: string) => mockLeakCheck(text) ?? actual.hasNoLeakingPii(text),
  }
})

const config = (overrides: Partial<AgentTeamConfig> = {}): AgentTeamConfig => ({
  maxTeammates: 3,
  maxConcurrentTeammates: 2,
  executionMode: "coordinated",
  displayMode: "expanded",
  writeMode: "single-writer",
  repositories: [
    { id: "primary", role: "primary", path: "/repo", writable: true },
    { id: "dep", role: "dependency", path: "/dep", writable: true },
  ],
  resourcePolicy: { priority: 2, maxConcurrentChildren: 2 },
  ...overrides,
})

const team = (overrides: Partial<AgentTeam> = {}): AgentTeam =>
  ({
    id: "team-1",
    projectId: "project-1",
    name: "Team",
    description: "",
    task: "Ship",
    status: "idle",
    config: config(),
    leadId: "lead-1",
    teammateIds: ["lead-1", "mate-1"],
    taskIds: ["task-1"],
    messageIds: [],
    progress: 0,
    totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    createdAt: new Date(1),
    ...overrides,
  }) as AgentTeam

describe("durableTeamSpec", () => {
  it("maps the team onto the coordinator's spec", () => {
    expect(
      durableTeamSpec(
        team({
          config: config({
            environmentRef: { environmentId: "env", versionId: "env-v3" },
            userConstraints: [{ title: "API", detail: "Keep it" }],
            workingDir: "/work",
          }),
        })
      )
    ).toEqual({
      id: "team-1",
      leadId: "lead-1",
      projectId: "project-1",
      objective: "Ship",
      repositories: config().repositories,
      workingDir: "/work",
      writeMode: "single-writer",
      resourcePolicy: { priority: 2, maxConcurrentChildren: 2 },
      maxConcurrentTeammates: 2,
      environmentVersionId: "env-v3",
      userConstraints: [{ title: "API", detail: "Keep it" }],
    })
  })

  it("leaves unset configuration out", () => {
    const spec = durableTeamSpec(
      team({
        projectId: undefined,
        config: {
          maxTeammates: 1,
          maxConcurrentTeammates: 1,
          executionMode: "coordinated",
          displayMode: "expanded",
        } as AgentTeamConfig,
      })
    )
    expect(spec).toEqual({
      id: "team-1",
      leadId: "lead-1",
      objective: "Ship",
      maxConcurrentTeammates: 1,
    })
  })
})

describe("redactTeamTextForPersistence", () => {
  afterEach(() => mockLeakCheck.mockReset().mockReturnValue(undefined))

  it("redacts with @cognia/redact", () => {
    const redacted = redactTeamTextForPersistence("Contact operator@example.com now")
    expect(redacted).toBeDefined()
    expect(redacted).not.toContain("operator@example.com")
  })

  it("refuses text that still leaks after redaction", () => {
    mockLeakCheck.mockReturnValue(false)
    expect(redactTeamTextForPersistence("anything")).toBeUndefined()
  })
})

describe("the app's durable AgentTeam coordinator", () => {
  let disableDbRuntime: (() => void) | undefined

  beforeEach(async () => {
    disableDbRuntime = __enableDbRuntimeForTesting()
    await getDb().delete()
    __resetDbForTesting()
    __resetDurableTeamCoordinatorForTesting()
    removeManagedFleetSession.mockReset().mockResolvedValue(true)
  })

  afterEach(async () => {
    jest.restoreAllMocks()
    mockLeakCheck.mockReset().mockReturnValue(undefined)
    await getDb().delete()
    __resetDbForTesting()
    disableDbRuntime?.()
  })

  const registerChild = (
    coordinator: ReturnType<typeof createDurableTeamCoordinator>,
    runId: string,
    childRunId: string
  ) =>
    coordinator.registerChild({
      runId,
      childRunId,
      teammateId: "mate-1",
      taskId: "task-1",
      repositoryId: "primary",
      access: "read",
    })

  it("keeps run state in Dexie by default", async () => {
    const coordinator = createDurableTeamCoordinator({ now: () => 50 })
    expect(coordinator.store).toBe(runtimeDb.dexieTeamRunStore)
    await coordinator.prepareRun(team(), "run-dexie")
    expect(await runtimeDb.getAgentTeamRun("run-dexie")).toMatchObject({
      teamId: "team-1",
      objective: "Ship",
      status: "running",
    })
  })

  it("journals the run under the bridge's execution id and notes a resumption", async () => {
    const coordinator = createDurableTeamCoordinator({ now: () => 90 })
    await coordinator.prepareRun(team(), "run-journal")
    // Addressed the way `agent-team-bridge` addresses it. Keying the row on the
    // bare run id made this path create a SECOND execution row for the same
    // run (`sourceId: <teamId>` rather than `<runId>`), which nothing deduped.
    expect(await getDb().executionRuns.get("run-journal")).toBeUndefined()
    expect(await getDb().executionRuns.get("execution:team:run-journal")).toMatchObject({
      kind: "team",
      sourceId: "run-journal",
      projectId: "project-1",
      title: "Ship",
      status: "running",
    })

    await getDb().executionRuns.update("execution:team:run-journal", { status: "waiting" })
    await createDurableTeamCoordinator({ now: () => 95 }).prepareRun(team(), "run-journal")
    const events = await runEventJournal.replay("execution:team:run-journal")
    expect(events.map((event) => event.type)).toEqual(["run.started", "run.resumed"])
  })

  it("sends the steering payload redacted by @cognia/redact to the live runtime", async () => {
    const coordinator = createDurableTeamCoordinator({ now: () => 225 })
    await coordinator.prepareRun(team(), "run-redacted-steer")
    await registerChild(coordinator, "run-redacted-steer", "child-redacted-steer")
    const steer = jest.fn(async () => undefined)
    coordinator.attachLiveControl("child-redacted-steer", { steer })

    const receipt = await coordinator.steer(
      "child-redacted-steer",
      "Contact operator@example.com before continuing"
    )

    expect(receipt.message).not.toContain("operator@example.com")
    expect(steer).toHaveBeenCalledWith(receipt.message, receipt.id)
  })

  it.each(["", "../outside", "/outside", "C:relative", "src\0file"])(
    "rejects invalid isolated ownership %s under the app's path semantics",
    async (path) => {
      const coordinator = createDurableTeamCoordinator()
      await coordinator.prepareRun(
        team({ config: config({ writeMode: "isolated-parallel" }) }),
        "run-admission"
      )
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
  )

  it("releases a terminated remote child's fleet session, even when removal fails", async () => {
    const coordinator = createDurableTeamCoordinator({ now: () => 250 })
    await coordinator.prepareRun(team(), "run-control")
    await registerChild(coordinator, "run-control", "child-control")
    await runtimeDb.updateAgentTeamChildRun("child-control", { remoteSessionId: "remote-control" })
    removeManagedFleetSession.mockRejectedValueOnce(new Error("projection offline"))

    await coordinator.terminateChild("child-control")

    expect(removeManagedFleetSession).toHaveBeenCalledWith("remote-control")
    expect((await runtimeDb.getAgentTeamChildRun("child-control"))?.status).toBe("terminated")
  })

  it("shares one coordinator, and replay checks read its store by default", async () => {
    const shared = getDurableTeamCoordinator()
    expect(getDurableTeamCoordinator()).toBe(shared)
    await shared.prepareRun(team(), "run-replay")
    await registerChild(shared, "run-replay", "child-replay")
    expect(await isDurableChildReplaySafe("child-replay")).toBe(false)
    await shared.checkpoint("child-replay", {
      trajectorySequence: 1,
      replay: "safe",
      sideEffects: [],
    })
    expect(await isDurableChildReplaySafe("child-replay")).toBe(true)
  })
})
