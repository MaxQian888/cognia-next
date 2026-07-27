import type { ExternalAgentInstance } from "@/types/agent/external-agent"
import { DEFAULT_GH_POLICY, type GhWorkOrder } from "@/lib/github/types"

import {
  ExternalAgentIssueLoopDriver,
  SelectableIssueLoopDriver,
} from "../drivers/external-agent-driver"
import { runIssueLoop, setIssueLoopDriver } from "./issue-loop"
import { setGithubRuntime } from "./runtime"

function configuredCodex(): ExternalAgentInstance {
  return {
    config: {
      id: "codex-main",
      name: "Codex",
      protocol: "codex-app-server",
      transport: "stdio",
      enabled: true,
    },
    connectionStatus: "connected",
    status: "ready",
    sessions: new Map(),
    capabilities: {
      toolExecution: true,
      fileOperations: true,
      multiTurn: true,
    },
    validity: {
      executable: true,
      checkedAt: new Date(0),
      source: "connect",
      sessionExtensions: {
        "session/list": { state: "unknown" },
        "session/fork": { state: "unknown" },
        "session/resume": { state: "unknown" },
      },
    },
    connectionAttempts: 0,
    stats: {
      totalExecutions: 0,
      successfulExecutions: 0,
      failedExecutions: 0,
      totalTokensUsed: 0,
      averageResponseTime: 0,
    },
  }
}

afterEach(() => {
  setIssueLoopDriver(null)
  setGithubRuntime(null)
})

it("drives Issue → exact External Agent → host push → PR with one WorkOrder authority", async () => {
  const order: string[] = []
  const workOrders: Array<Partial<GhWorkOrder>> = []
  const octokit = {
    auth: jest.fn(async () => ({ token: "host-only-token" })),
    request: jest.fn(async (route: string, params: Record<string, unknown>) => {
      if (route.includes("/issues/{issue_number}") && route.startsWith("GET")) {
        order.push("issue")
        return { data: { title: "Fix fixture", body: "Change README." } }
      }
      if (route.includes("/pulls") && route.startsWith("POST")) {
        order.push("pr")
        expect(params.body).toContain("Driver: codex-main.")
        return { data: { number: 4, html_url: "https://github.test/o/r/pull/4" } }
      }
      if (route.includes("/labels")) order.push("label")
      return { data: {} }
    }),
  }
  setGithubRuntime({
    getRepo: async () => null,
    getOctokit: async () => octokit as unknown as import("@octokit/core").Octokit,
    recordAudit: async () => undefined,
    checkPolicy: async () => ({
      decision: { allow: true },
      effectivePolicy: DEFAULT_GH_POLICY,
    }),
    getWorkOrder: async () => null,
    upsertWorkOrder: async (params) => {
      workOrders.push(params)
      return { ...params, createdAt: 0, updatedAt: 0 }
    },
  })

  const codex = configuredCodex()
  const manager = {
    getAgent: jest.fn(() => codex),
    connect: jest.fn(async () => undefined),
    execute: jest.fn(async () => {
      order.push("agent")
      return {
        success: true,
        sessionId: "codex-session",
        finalResponse: "<SUMMARY>Updated README.</SUMMARY>",
        messages: [],
        steps: [],
        toolCalls: [],
        duration: 50,
      }
    }),
  }
  setIssueLoopDriver(
    new SelectableIssueLoopDriver({
      external: new ExternalAgentIssueLoopDriver({
        manager,
        runtimeSupportsExternalAgents: () => true,
      }),
    })
  )

  const result = await runIssueLoop(
    {
      repoFullName: "o/r",
      issueNumber: 3,
      externalAgentId: "codex-main",
      workflowRunId: "run-1",
      workflowStepId: "step-1",
    },
    {
      cloneToWorkspace: async ({ token }) => {
        order.push("clone")
        expect(token).toBe("host-only-token")
        return {
          backend: "local",
          path: "/delivery/o-r-3",
          repoFullName: "o/r",
          branch: "main",
          createdAt: 0,
        }
      },
      commitAndPush: async ({ token }) => {
        order.push("push")
        expect(token).toBe("host-only-token")
        return "sha"
      },
    }
  )

  expect(result).toMatchObject({ status: "pr_opened", prNumber: 4 })
  expect(order).toEqual(["issue", "clone", "agent", "push", "pr", "label"])
  expect(manager.execute).toHaveBeenCalledWith(
    "codex-main",
    expect.any(String),
    expect.not.objectContaining({
      env: expect.anything(),
    })
  )
  expect(workOrders.at(-1)).toMatchObject({
    status: "pr_opened",
    prNumber: 4,
    aiDriver: "codex-main",
  })
})
