import { enqueueCollabMutation } from "@/lib/db/mobile-outbound-queue"
import { DEFAULT_PLAN_CONFIG, type AgentPlan } from "@/types/agent/plan"
import type { IssueRun } from "@/types/issues"

import { publishPlanToCollab, publishRunToCollab } from "./publish"

jest.mock("@/lib/db/mobile-outbound-queue", () => ({
  enqueueCollabMutation: jest.fn().mockResolvedValue({}),
}))

const enqueue = jest.mocked(enqueueCollabMutation)

beforeEach(() => enqueue.mockClear())

it("publishes only the readable plan projection", async () => {
  const plan: AgentPlan = {
    id: "plan-local",
    sessionId: "session-secret",
    projectId: "/Users/alice/private",
    title: "Release",
    description: "Public summary",
    source: "manual",
    executionMode: "orchestrated",
    steps: [
      {
        id: "step-secret",
        title: "Deploy",
        description: "Ship it",
        kind: "tool_call",
        status: "ready",
        order: 0,
        dependencies: [],
        params: { kind: "tool_call", toolName: "shell", input: { token: "secret" } },
        output: { credential: "secret" },
      },
    ],
    status: "approved",
    totalSteps: 1,
    completedSteps: 0,
    config: DEFAULT_PLAN_CONFIG,
    refinementCount: 0,
    generationId: "runtime-handle",
    createdAt: 1,
    updatedAt: 1,
    metadata: { prompt: "secret" },
  }
  await publishPlanToCollab(plan, { orgId: "org-1", workspaceId: "workspace-1" })
  expect(enqueue).toHaveBeenCalledWith({
    command: "collab_plan_create",
    orgId: "org-1",
    entityType: "plan",
    entityId: "plan-local",
    payload: {
      workspaceId: "workspace-1",
      title: "Release",
      description: "Public summary",
      status: "approved",
      steps: [
        {
          title: "Deploy",
          description: "Ship it",
          kind: "tool_call",
          status: "ready",
        },
      ],
    },
  })
  expect(JSON.stringify(enqueue.mock.calls[0])).not.toMatch(
    /session-secret|runtime-handle|token|credential|params|output|prompt|\/Users/
  )
})

it("publishes a run without runtime handles or non-web artifacts", async () => {
  const run: IssueRun = {
    id: "run-local",
    issueId: "issue-local",
    projectId: "/private/workspace",
    adapterId: "agent-task",
    kind: "agent-task",
    targetId: "runtime-handle",
    targetRef: { taskId: "secret" },
    status: "succeeded",
    by: { kind: "human" },
    startedAt: 1,
    updatedAt: 2,
    artifacts: [
      { label: "Pull request", href: "https://example.test/pr/1" },
      { label: "Local session", href: "/?session=secret" },
      { label: "File", href: "file:///private/result" },
    ],
    summary: "private result",
  }
  await publishRunToCollab(run, "Run MERC-1", {
    orgId: "org-1",
    workspaceId: "workspace-1",
  })
  expect(enqueue).toHaveBeenCalledWith({
    command: "collab_run_create",
    orgId: "org-1",
    entityType: "run",
    entityId: "run-local",
    payload: {
      workspaceId: "workspace-1",
      title: "Run MERC-1",
      kind: "agent-task",
      status: "succeeded",
      artifacts: [{ label: "Pull request", href: "https://example.test/pr/1" }],
    },
  })
  expect(JSON.stringify(enqueue.mock.calls[0])).not.toMatch(
    /runtime-handle|taskId|private result|file:|session=secret/
  )
})
