import { renderHook } from "@testing-library/react"
import type {
  SiteDeploymentRow,
  SiteEnvironmentRevisionRow,
  SiteOperationEventRow,
  SiteOperationRow,
  SiteVersionRow,
} from "@/types/sites"

jest.mock("dexie-react-hooks", () => ({ useLiveQuery: jest.fn() }))
jest.mock("@/lib/db/sites", () => ({
  listSiteProjects: jest.fn(async () => []),
  listActiveSiteDeployments: jest.fn(async () => []),
  listSiteOperationSignals: jest.fn(async () => []),
  listSiteVersions: jest.fn(async () => []),
  listSiteDeployments: jest.fn(async () => []),
  listSiteEnvironmentRevisions: jest.fn(async () => []),
  listSiteResources: jest.fn(async () => []),
  listSiteOperations: jest.fn(async () => []),
  listSiteOperationEvents: jest.fn(async () => []),
}))

import { useLiveQuery } from "dexie-react-hooks"
import * as db from "@/lib/db/sites"
import {
  SITE_STEP_ORDER,
  deriveStepStates,
  newestEventMessage,
  pickRunningOperation,
  stepOfOperation,
  useSiteLiveData,
  type StepDerivationInput,
} from "./use-site-live-data"

const useLiveQueryMock = useLiveQuery as jest.Mock

function operation(overrides: Partial<SiteOperationRow>): SiteOperationRow {
  return {
    id: "op",
    siteId: "site-1",
    type: "build",
    executionTargetKey: "local",
    idempotencyKey: "k",
    inputDigest: "d",
    status: "running",
    attemptCount: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

const READY_VERSION = { status: "ready" } as SiteVersionRow
const ACTIVE_DEPLOYMENT = { status: "active" } as SiteDeploymentRow
const ONE_ENVIRONMENT = [{ id: "env-1" } as SiteEnvironmentRevisionRow]

function stepInput(overrides: Partial<StepDerivationInput> = {}): StepDerivationInput {
  return {
    connectDone: false,
    manifestReady: false,
    environments: [],
    versions: [],
    deployments: [],
    previewActive: false,
    operations: [],
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe("deriveStepStates", () => {
  it("marks satisfied predicates done and everything else idle", () => {
    const states = deriveStepStates(
      stepInput({
        connectDone: true,
        manifestReady: true,
        environments: ONE_ENVIRONMENT,
        versions: [READY_VERSION],
        deployments: [ACTIVE_DEPLOYMENT],
        previewActive: true,
      })
    )
    expect(states).toEqual({
      connect: "done",
      manifest: "done",
      environment: "done",
      build: "done",
      preview: "done",
      publish: "done",
    })
  })

  it("drives the manifest step from the file, not from an operation", () => {
    expect(deriveStepStates(stepInput({ manifestReady: true })).manifest).toBe("done")
    expect(deriveStepStates(stepInput({ manifestReady: false })).manifest).toBe("idle")
    // No `SiteOperationType` maps to the manifest step, so an in-flight
    // operation must never make it look busy.
    expect(
      deriveStepStates(
        stepInput({ manifestReady: true, operations: [operation({ type: "build" })] })
      ).manifest
    ).toBe("done")
  })

  it("orders the manifest between connecting and the environment", () => {
    expect([...SITE_STEP_ORDER]).toEqual([
      "connect",
      "manifest",
      "environment",
      "build",
      "preview",
      "publish",
    ])
  })

  it("is all idle with no signals", () => {
    expect(deriveStepStates(stepInput())).toEqual({
      connect: "idle",
      manifest: "idle",
      environment: "idle",
      build: "idle",
      preview: "idle",
      publish: "idle",
    })
  })

  it("shows the step running while its operation is in flight, even over a ready version", () => {
    const states = deriveStepStates(
      stepInput({
        versions: [READY_VERSION],
        operations: [operation({ type: "build", status: "running", updatedAt: 5 })],
      })
    )
    expect(states.build).toBe("running")
  })

  it("treats a queued upload/deploy as the publish step running", () => {
    const states = deriveStepStates(
      stepInput({ operations: [operation({ type: "upload", status: "queued" })] })
    )
    expect(states.publish).toBe("running")
  })

  it("surfaces a failed build when no newer success exists", () => {
    const states = deriveStepStates(
      stepInput({ operations: [operation({ type: "build", status: "failed" })] })
    )
    expect(states.build).toBe("failed")
  })

  it("treats a waiting-reconcile deploy as failed on the publish step", () => {
    const states = deriveStepStates(
      stepInput({ operations: [operation({ type: "deploy", status: "waiting-reconcile" })] })
    )
    expect(states.publish).toBe("failed")
  })

  it("lets a success supersede an older failed operation via updatedAt ordering", () => {
    const states = deriveStepStates(
      stepInput({
        deployments: [ACTIVE_DEPLOYMENT],
        operations: [
          operation({ type: "deploy", status: "failed", updatedAt: 1 }),
          operation({ type: "deploy", status: "succeeded", updatedAt: 2 }),
        ],
      })
    )
    expect(states.publish).toBe("done")
  })

  it("ignores advanced/lifecycle operations for step state", () => {
    const states = deriveStepStates(
      stepInput({ operations: [operation({ type: "purge", status: "running" })] })
    )
    expect(states.build).toBe("idle")
    expect(states.publish).toBe("idle")
  })
})

describe("pickRunningOperation", () => {
  it("returns the newest in-flight operation", () => {
    const chosen = pickRunningOperation([
      operation({ id: "a", status: "running", updatedAt: 1 }),
      operation({ id: "b", status: "queued", updatedAt: 3 }),
      operation({ id: "c", status: "succeeded", updatedAt: 9 }),
    ])
    expect(chosen?.id).toBe("b")
  })

  it("returns undefined when nothing is in flight", () => {
    expect(pickRunningOperation([operation({ status: "succeeded" })])).toBeUndefined()
  })
})

describe("newestEventMessage", () => {
  const events: SiteOperationEventRow[] = [
    { id: "e1", operationId: "op-1", sequence: 1, type: "claimed", message: "start", createdAt: 1 },
    {
      id: "e2",
      operationId: "op-1",
      sequence: 2,
      type: "succeeded",
      message: "done",
      createdAt: 2,
    },
  ]

  it("returns the highest-sequence message", () => {
    expect(newestEventMessage(events)).toBe("done")
  })

  it("returns undefined for an empty stream", () => {
    expect(newestEventMessage([])).toBeUndefined()
  })
})

describe("stepOfOperation", () => {
  it("maps operation types to their step, null for advanced ones", () => {
    expect(stepOfOperation(operation({ type: "deploy" }))).toBe("publish")
    expect(stepOfOperation(operation({ type: "provision" }))).toBe("build")
    expect(stepOfOperation(operation({ type: "access" }))).toBeNull()
    expect(stepOfOperation(undefined)).toBeNull()
  })
})

describe("useSiteLiveData", () => {
  /**
   * The hook drives two live queries — the Site index (deps `[]`) and the
   * selected Site's detail (deps `[selectedId]`). The mock records both so a
   * test can run either querier and assert which tables it touched.
   */
  function captureQueries() {
    const calls: Array<{
      run: () => Promise<Record<string, unknown>>
      deps: unknown[]
    }> = []
    useLiveQueryMock.mockImplementation(
      (run: () => Promise<Record<string, unknown>>, deps: unknown[]) => {
        calls.push({ run, deps })
        return undefined
      }
    )
    return calls
  }

  it("reports loading with empty tables and no selection before the first snapshot", () => {
    useLiveQueryMock.mockReturnValue(undefined)
    const { result } = renderHook(() => useSiteLiveData(null))
    expect(result.current.loading).toBe(true)
    expect(result.current.sites).toEqual([])
    expect(result.current.selectedId).toBeNull()
    expect(result.current.operations).toEqual([])
  })

  it("maps resolved index + detail snapshots onto the live-data shape", () => {
    useLiveQueryMock
      .mockReturnValueOnce({
        sites: [{ id: "site-1" }],
        activeDeployments: [ACTIVE_DEPLOYMENT],
        operationSignals: [],
      })
      .mockReturnValueOnce({
        versions: [READY_VERSION],
        deployments: [ACTIVE_DEPLOYMENT],
        environments: ONE_ENVIRONMENT,
        resources: [],
        operations: [operation({ id: "op-1" })],
      })
    const { result } = renderHook(() => useSiteLiveData("site-1"))
    expect(result.current.loading).toBe(false)
    expect(result.current.sites).toHaveLength(1)
    expect(result.current.selectedId).toBe("site-1")
    expect(result.current.versions).toHaveLength(1)
    expect(result.current.operations[0].id).toBe("op-1")
    expect(result.current.activeDeployments).toHaveLength(1)
  })

  it("does not stay in loading while only the detail query is outstanding", () => {
    // The rail and the empty state key off `loading`; a Site list that has
    // already resolved must not read as still loading because its detail has
    // not.
    useLiveQueryMock
      .mockReturnValueOnce({
        sites: [{ id: "site-1" }],
        activeDeployments: [],
        operationSignals: [],
      })
      .mockReturnValueOnce(undefined)
    const { result } = renderHook(() => useSiteLiveData("site-1"))
    expect(result.current.loading).toBe(false)
    expect(result.current.versions).toEqual([])
  })

  it("never reads operation events — those are scoped per operation now", async () => {
    ;(db.listSiteProjects as jest.Mock).mockResolvedValue([{ id: "site-1" }])
    ;(db.listSiteOperations as jest.Mock).mockResolvedValue([operation({ id: "op-1" })])
    const calls = captureQueries()
    renderHook(() => useSiteLiveData("site-1"))
    await Promise.all(calls.map((call) => call.run()))
    expect(db.listSiteOperationEvents).not.toHaveBeenCalled()
  })

  it("keeps the Site index independent of the selection", async () => {
    // Deps `[]`: a write to one Site's versions must not re-read the rail, and
    // switching selection must not re-read the Site list.
    const calls = captureQueries()
    renderHook(() => useSiteLiveData("site-1"))
    expect(calls[0]?.deps).toEqual([])
    expect(calls[1]?.deps).toEqual(["site-1"])
  })

  it("loads the cross-Site rail signals in the index query", async () => {
    // Without these the rail can only label the selected row; every other Site
    // would show a bare name with no idea whether it is live, busy, or broken.
    ;(db.listSiteProjects as jest.Mock).mockResolvedValue([{ id: "site-1" }, { id: "site-2" }])
    ;(db.listActiveSiteDeployments as jest.Mock).mockResolvedValue([
      { id: "dep", siteId: "site-2" },
    ])
    ;(db.listSiteOperationSignals as jest.Mock).mockResolvedValue([
      { id: "op", siteId: "site-2", status: "running" },
    ])
    const calls = captureQueries()
    renderHook(() => useSiteLiveData("site-1"))
    const index = await calls[0]!.run()
    expect(index.activeDeployments).toHaveLength(1)
    expect(index.operationSignals).toHaveLength(1)
  })

  it("reads the selected Site's own tables in the detail query", async () => {
    const calls = captureQueries()
    renderHook(() => useSiteLiveData("site-1"))
    await calls[1]!.run()
    expect(db.listSiteVersions).toHaveBeenCalledWith("site-1")
    expect(db.listSiteDeployments).toHaveBeenCalledWith("site-1")
    expect(db.listSiteOperations).toHaveBeenCalledWith("site-1")
  })

  it("auto-selects the first site once the index resolves", () => {
    useLiveQueryMock.mockReturnValue({
      sites: [{ id: "site-a" }, { id: "site-b" }],
      activeDeployments: [],
      operationSignals: [],
    })
    const { result } = renderHook(() => useSiteLiveData(null))
    expect(result.current.selectedId).toBe("site-a")
  })

  it("reads no per-Site tables when there is nothing to select", async () => {
    useLiveQueryMock.mockReturnValue(undefined)
    const calls = captureQueries()
    renderHook(() => useSiteLiveData(null))
    const detail = await calls[1]!.run()
    expect(detail.versions).toEqual([])
    expect(db.listSiteVersions).not.toHaveBeenCalled()
  })
})
