import { registerRunRecoveryOwner, resumeInFlightRuns } from "./resume-controller"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import type { VisualWorkflow } from "@/types/workflow/visual"

// Mock the Tauri bridge so tests don't depend on a Tauri window. Each test
// overrides `reloadInFlightRuns` with a fixture set of rows.
jest.mock("./tauri-bridge", () => ({
  reloadInFlightRuns: jest.fn(),
  persistRunState: jest.fn(),
  ackRunCompleted: jest.fn(),
  registerTrigger: jest.fn(),
  unregisterTrigger: jest.fn(),
  listenTriggerEvents: jest.fn(),
  listenResumeEvents: jest.fn(),
}))

import { reloadInFlightRuns } from "./tauri-bridge"

const mockedReload = reloadInFlightRuns as jest.MockedFunction<typeof reloadInFlightRuns>

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await getDb().workflowRuns.clear()
  await getDb().workflowRunEvents.clear()
  mockedReload.mockReset()
})
afterAll(dbFixture.dispose)

describe("resumeInFlightRuns", () => {
  it("returns an all-zero summary when there are no in-flight rows", async () => {
    mockedReload.mockResolvedValueOnce([])
    const r = await resumeInFlightRuns()
    expect(r).toEqual({ attempted: 0, succeeded: 0, failed: 0, skipped: 0, delegated: 0 })
  })

  it("skips rows whose snapshot is missing or malformed", async () => {
    mockedReload.mockResolvedValueOnce([
      {
        runId: "run_a",
        workflowId: "wf_x",
        startedAt: 0,
        snapshot: null as unknown as VisualWorkflow,
      },
      {
        runId: "run_b",
        workflowId: "wf_x",
        startedAt: 0,
        snapshot: { name: "missing id" } as unknown as VisualWorkflow,
      },
    ])
    const r = await resumeInFlightRuns()
    expect(r.attempted).toBe(2)
    expect(r.skipped).toBe(2)
    expect(r.succeeded).toBe(0)
    expect(r.failed).toBe(0)
  })

  it("counts a successful replay as succeeded", async () => {
    const snapshot = {
      id: "wf_resumed",
      schemaVersion: 1,
      name: "Resumed",
      createdAt: 0,
      updatedAt: 0,
      nodes: [
        {
          id: "n_start",
          type: "trigger.manual",
          typeVersion: 1,
          position: { x: 0, y: 0 },
          data: { label: "start", params: {} },
        },
      ],
      edges: [],
      settings: {
        errorPolicy: "stop",
        timeoutMs: 60_000,
        concurrency: 1,
        retryDefaults: { attempts: 1, backoff: "fixed", baseMs: 0 },
      },
    }
    mockedReload.mockResolvedValueOnce([
      {
        runId: "run_resumed",
        workflowId: snapshot.id,
        startedAt: 1,
        snapshot: snapshot as unknown as VisualWorkflow,
      },
    ])
    const r = await resumeInFlightRuns()
    expect(r.attempted).toBe(1)
    expect(r.succeeded).toBe(1)
    expect(r.failed).toBe(0)
  })

  it("counts a failing replay as failed without throwing", async () => {
    const snapshot = {
      id: "wf_bad",
      schemaVersion: 1,
      name: "Bad",
      createdAt: 0,
      updatedAt: 0,
      nodes: [
        {
          id: "n_start",
          type: "trigger.manual",
          typeVersion: 1,
          position: { x: 0, y: 0 },
          data: { label: "start", params: {} },
        },
        {
          // Unregistered kind — the orchestrator returns status: failed.
          id: "n_team",
          type: "action.team.run",
          typeVersion: 1,
          position: { x: 200, y: 0 },
          data: { label: "team", params: {} },
        },
      ],
      edges: [{ id: "e1", source: "n_start", target: "n_team" }],
      settings: {
        errorPolicy: "stop",
        timeoutMs: 60_000,
        concurrency: 1,
        retryDefaults: { attempts: 1, backoff: "fixed", baseMs: 0 },
      },
    }
    mockedReload.mockResolvedValueOnce([
      {
        runId: "run_failing",
        workflowId: snapshot.id,
        startedAt: 1,
        snapshot: snapshot as unknown as VisualWorkflow,
      },
    ])
    const r = await resumeInFlightRuns()
    expect(r.attempted).toBe(1)
    expect(r.failed).toBe(1)
    expect(r.succeeded).toBe(0)
  })

  it("leaves runs a recovery owner claims to that owner instead of replaying them", async () => {
    const unregister = registerRunRecoveryOwner({
      id: "test-owner",
      owns: (row) => row.workflowId.startsWith("__owned__:"),
    })
    try {
      mockedReload.mockResolvedValueOnce([
        {
          runId: "run_owned",
          workflowId: "__owned__:x",
          startedAt: 0,
          snapshot: { id: "__owned__:x" } as unknown as VisualWorkflow,
        },
      ])
      const r = await resumeInFlightRuns()
      expect(r).toEqual({ attempted: 1, succeeded: 0, failed: 0, skipped: 0, delegated: 1 })
      expect(await getDb().workflowRuns.get("run_owned")).toBeUndefined()
    } finally {
      unregister()
    }
  })
})
