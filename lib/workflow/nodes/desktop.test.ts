/**
 * Tests for the canonical revision-bound desktop workflow executors.
 */

jest.mock("@/lib/automation/client", () => ({
  desktop: {
    listApps: jest.fn(),
    getAppState: jest.fn(),
    queryElements: jest.fn(),
    expandElement: jest.fn(),
    performAction: jest.fn(),
  },
}))

import { desktop } from "@/lib/automation/client"
import type { StepExecutionContext, TriggerEvent } from "@/types/workflow/visual"
import "./desktop"
import { getExecutor } from "./registry"

const mocks = desktop as unknown as Record<string, jest.Mock>

function makeCtx(params: Record<string, unknown> = {}): StepExecutionContext {
  return {
    runId: "r1",
    workflowId: "w1",
    stepId: "s1",
    params,
    upstream: {},
    trigger: {
      kind: "trigger.manual",
      runId: "r1",
      workflowId: "w1",
      originAt: 42,
      payload: { source: "fixture" },
    } as unknown as TriggerEvent,
    signal: new AbortController().signal,
    log: () => {},
    resolveSecret: async () => undefined,
  }
}

const callContext = {
  surface: "workflow",
  sessionKey: "w1",
  turnKey: "r1",
}

const handle = {
  sessionId: "workflow:w1:r1",
  lineageId: "lineage-1",
  revision: 2,
  index: 3,
  fingerprint: "button:Save",
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset()
  }
})

describe("canonical desktop workflow executors", () => {
  it("lists applications through the shared workflow call context", async () => {
    mocks.listApps.mockResolvedValueOnce([{ displayName: "TextEdit", processId: 7 }])

    const result = await getExecutor("action.desktop.listApps", 1)!.execute(makeCtx())

    expect(mocks.listApps).toHaveBeenCalledWith(callContext)
    expect(result.output).toEqual({
      apps: [{ displayName: "TextEdit", processId: 7 }],
    })
  })

  it("gets state with a stable run-scoped session by default", async () => {
    const state = { sessionId: "workflow:w1:r1", revision: 1, turnToken: "turn-1" }
    mocks.getAppState.mockResolvedValueOnce(state)

    const result = await getExecutor("action.desktop.getAppState", 1)!.execute(
      makeCtx({
        locator: { kind: "bundleId", bundleId: "com.apple.TextEdit" },
        options: { maxNodes: 500 },
      })
    )

    expect(mocks.getAppState).toHaveBeenCalledWith(
      "workflow:w1:r1",
      { kind: "bundleId", bundleId: "com.apple.TextEdit" },
      { maxNodes: 500 },
      callContext
    )
    expect(result.output).toBe(state)
  })

  it("honors an explicit session id for state reads", async () => {
    mocks.getAppState.mockResolvedValueOnce({})

    await getExecutor("action.desktop.getAppState", 1)!.execute(
      makeCtx({
        sessionId: "existing-session",
        locator: { kind: "displayName", displayName: "TextEdit" },
      })
    )

    expect(mocks.getAppState).toHaveBeenCalledWith(
      "existing-session",
      { kind: "displayName", displayName: "TextEdit" },
      {},
      callContext
    )
  })

  it("requires a locator for state reads", async () => {
    await expect(getExecutor("action.desktop.getAppState", 1)!.execute(makeCtx())).rejects.toThrow(
      "requires an object 'locator'"
    )
  })

  it("queries only the specified revision lineage", async () => {
    mocks.queryElements.mockResolvedValueOnce([{ handle }])

    const result = await getExecutor("action.desktop.queryElements", 1)!.execute(
      makeCtx({
        sessionId: handle.sessionId,
        lineageId: handle.lineageId,
        revision: handle.revision,
        locator: { controlType: "AXButton" },
        limit: 20,
      })
    )

    expect(mocks.queryElements).toHaveBeenCalledWith(
      {
        sessionId: handle.sessionId,
        lineageId: handle.lineageId,
        revision: handle.revision,
      },
      { controlType: "AXButton" },
      20,
      callContext
    )
    expect(result.output).toEqual({ nodes: [{ handle }] })
  })

  it("rejects an incomplete revision identity", async () => {
    await expect(
      getExecutor("action.desktop.queryElements", 1)!.execute(
        makeCtx({ sessionId: handle.sessionId, revision: handle.revision })
      )
    ).rejects.toThrow("requires sessionId, lineageId, and revision")
  })

  it("expands a handle with canonical pagination", async () => {
    const page = { nodes: [], continuationToken: "next-page" }
    mocks.expandElement.mockResolvedValueOnce(page)

    const result = await getExecutor("action.desktop.expandElement", 1)!.execute(
      makeCtx({ handle, continuationToken: "page-1", limit: 25 })
    )

    expect(mocks.expandElement).toHaveBeenCalledWith(handle, "page-1", 25, callContext)
    expect(result.output).toBe(page)
  })

  it("forwards the action envelope without translating coordinates or actions", async () => {
    const request = {
      turnToken: "turn-1",
      target: { kind: "element", handle },
      action: { kind: "click" },
      strategy: "semantic",
    }
    const actionResult = {
      status: "delivered",
      beforeRevision: 2,
      afterRevision: 3,
    }
    mocks.performAction.mockResolvedValueOnce(actionResult)

    const result = await getExecutor("action.desktop.performAction", 1)!.execute(
      makeCtx({ request })
    )

    expect(mocks.performAction).toHaveBeenCalledWith(request, callContext)
    expect(result.output).toBe(actionResult)
  })
})

describe("trigger.desktop.event", () => {
  it("echoes the subscribed kinds and trigger evidence", async () => {
    const result = await getExecutor("trigger.desktop.event", 1)!.execute(
      makeCtx({ kinds: ["focus-changed"] })
    )

    expect(result.output).toEqual({
      kinds: ["focus-changed"],
      firedAt: 42,
      payload: { source: "fixture" },
    })
  })
})
