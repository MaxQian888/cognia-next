/** @jest-environment jsdom */
import "fake-indexeddb/auto"

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
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { createRunLogger, listRunEvents } from "@/lib/workflow/runtime/event-log"
import { IdempotencyCache } from "@/lib/workflow/runtime/idempotency"
import { NoopSecretResolver } from "@/lib/workflow/runtime/secret-resolver"
import { runStep } from "@/lib/workflow/runtime/step-executor"
import { DEFAULT_WORKFLOW_SETTINGS, type WorkflowNode } from "@/types/workflow/visual"
import "./desktop"

const handle = {
  sessionId: "missing-session",
  lineageId: "missing-lineage",
  revision: 1,
  index: 0,
  fingerprint: "missing-button",
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  await whenSeeded()
  jest.clearAllMocks()
})

it.each([
  ["action.desktop.queryElements", "queryElements", { ...handle, locator: {} }],
  ["action.desktop.expandElement", "expandElement", { handle }],
  [
    "action.desktop.performAction",
    "performAction",
    {
      request: {
        turnToken: "single-use-token",
        target: { kind: "element", handle },
        action: { kind: "click" },
        strategy: "semantic",
      },
    },
  ],
] as const)(
  "%s is attempted once even with a per-node retry override",
  async (kind, method, params) => {
    const call = desktop[method] as jest.Mock
    const failure = new Error("native result unavailable after dispatch")
    call.mockRejectedValueOnce(failure).mockResolvedValue({ nodes: [] })
    const node: WorkflowNode = {
      id: "desktop-step",
      type: kind,
      typeVersion: 1,
      position: { x: 0, y: 0 },
      data: {
        label: method,
        params,
        errorHandling: { retry: { maxRetries: 2, retryIntervalMs: 0, backoff: "fixed" } },
      },
    }
    const runId = "native-retry-test"
    const cache = await IdempotencyCache.hydrate(runId)
    await expect(
      runStep({
        workflow: {
          id: "workflow",
          schemaVersion: 2,
          name: "Desktop retry contract",
          nodes: [node],
          edges: [],
          settings: DEFAULT_WORKFLOW_SETTINGS,
          createdAt: 0,
          updatedAt: 0,
        },
        node,
        trigger: { workflowId: "workflow", kind: "trigger.manual", payload: {}, originAt: 0 },
        upstream: {},
        runId,
        signal: new AbortController().signal,
        cache,
        retryPolicy: { attempts: 3, baseMs: 0, backoff: "fixed" },
        secretResolver: NoopSecretResolver,
        logger: createRunLogger(runId),
      })
    ).rejects.toThrow(failure)
    expect(call).toHaveBeenCalledTimes(1)
    expect(cache.has(node.id)).toBe(false)
    const events = await listRunEvents(runId)
    expect(events.filter((event) => event.type === "step_started")).toHaveLength(1)
    expect(events.some((event) => event.type === "step_retrying")).toBe(false)
  }
)
