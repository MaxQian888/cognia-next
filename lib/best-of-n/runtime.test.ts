import type { BestOfNGroup } from "@/types/best-of-n"
import type { BestOfNInput } from "./core"
import type { SendOptions } from "@cognia/agent-config-types"

const prepareRun = jest.fn()
const store = { getRun: jest.fn(), updateRunIfCurrent: jest.fn() }
const dispatch = {
  setWorkspace: jest.fn(),
  attachControl: jest.fn(),
  run: jest.fn((op) => op()),
  capture: jest.fn(),
  complete: jest.fn(),
  fail: jest.fn(),
  dispose: jest.fn(),
}
const begin = jest.fn<Promise<typeof dispatch>, unknown[]>(async () => dispatch)
const bundle = {
  bundleId: "bundle",
  state: "active",
  ownerRef: "session",
  leases: [
    { role: "primary", logicalRootId: "repo", workspaceId: "workspace", aliasPath: "/alias" },
  ],
}
const acquire = jest.fn<Promise<typeof bundle>, unknown[]>(async () => bundle)
const settle = jest.fn()
const options: SendOptions = Object.freeze({
  model: "chosen",
  maxBudgetUsd: 2,
  execution: { runtimeAdapter: "claude-agent-sdk" } as SendOptions["execution"],
})
const resolve = jest.fn<Promise<SendOptions>, unknown[]>(async () => options)
const capture = jest.fn()
const run = jest.fn()
const sessions = { get: jest.fn(), add: jest.fn() }
jest.mock("@/lib/ai/agent/team/durable/durable-runtime", () => ({
  getDurableTeamCoordinator: () => ({ prepareRun, store }),
}))
jest.mock("@/lib/ai/agent/team/durable/durable-dispatch", () => ({
  beginDurableDispatch: (...args: unknown[]) => begin(...args),
}))
jest.mock("@/lib/ai/agent/team/durable/durable-control", () => ({ controlDurableRun: jest.fn() }))
jest.mock("@/lib/task-workspace/client", () => ({
  acquireWorkspaceBundle: (...args: unknown[]) => acquire(...args),
  getWorkspaceBundle: async () => bundle,
  ensureWorkspacePortLease: async () => ({ canonicalRoot: "/physical" }),
}))
jest.mock("@/lib/task-workspace/run-lease", () => ({
  openWorkspaceBundleTurnLease: async () => ({ settle }),
}))
jest.mock("@/lib/task-workspace/user-action", () => ({
  runWorkspaceUserAction: (_name: string, op: () => unknown) => op(),
}))
jest.mock("@/lib/scm/host", () => ({
  createScmHost: () => ({ captureChangeset: (...args: unknown[]) => capture(...args) }),
  scmErrorCode: (error: { code: string }) => error.code,
}))
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    sessions,
    transaction: (_mode: string, _table: unknown, op: () => unknown) => op(),
  }),
}))
jest.mock("@/lib/db/characters", () => ({ getCharacter: async () => ({ id: "agent" }) }))
jest.mock("@/lib/db/settings", () => ({ getSettings: async () => ({}) }))
jest.mock("@/lib/claude/build-options", () => ({
  resolveSendOptions: (...args: unknown[]) => resolve(...args),
}))
jest.mock("@/lib/claude/run-and-capture", () => ({
  runAndCaptureAssistantReply: (...args: unknown[]) => run(...args),
}))
jest.mock("@/lib/claude/ipc", () => ({ interruptSession: jest.fn() }))
import { bestOfNTeam, createBestOfNExecution } from "./runtime"
import { candidateGrant } from "./core"

const candidate = {
  candidateId: "candidate",
  index: 0,
  agent: { agentId: "agent", model: "chosen" },
  childSessionId: "session",
}
const group = {
  groupId: "group",
  teamRunId: "team",
  repositoryId: "repo",
  sourceRoot: "/source",
  baseSha: "frozen",
  targetRef: "refs/heads/result",
  n: 2,
  budgetPolicy: { maxCostUsd: 4, maxDurationMs: 10000 },
  createdAt: Date.now(),
  candidates: [candidate],
} as BestOfNGroup
const request = {
  prompt: "Fix this",
  projectId: "project",
  requiredChecks: ["approved-test"],
} as BestOfNInput

beforeEach(() => {
  jest.clearAllMocks()
  resolve.mockResolvedValue(options)
  sessions.get.mockResolvedValue(undefined)
  capture.mockResolvedValue({
    changesetId: "change",
    headSha: "head",
    files: [{ path: "a.ts", excluded: false }],
  })
  run.mockResolvedValue({ text: "done", resultSubtype: "success" })
})

it("binds a valid durable team without a planning or cross-candidate evidence gate", async () => {
  const team = bestOfNTeam(group, request)
  expect(team.config.repositories).toEqual([
    { id: "repo", path: "/source", role: "primary", writable: true },
  ])
  expect(team.config.evidencePolicy).toMatchObject({
    requireCodeDiff: false,
    requireVerification: false,
  })
  expect(team.config.enableMessaging).toBe(false)
  await createBestOfNExecution().prepare(group, request)
  expect(prepareRun).toHaveBeenCalledWith(team, "team")
})

it("acquires the frozen base for the Host-assigned child, reusing its port block", async () => {
  const workspace = await createBestOfNExecution().acquire(group, group.candidates[0], request)
  expect(acquire).toHaveBeenCalledWith(
    expect.objectContaining({
      base: { kind: "gitRef", gitRef: "frozen" },
      ownerType: "session",
      ownerRef: "session",
    })
  )
  expect(workspace.physicalRoot).toBe("/physical")
})

async function execute(executionGroup = group) {
  return createBestOfNExecution().execute({
    group: executionGroup,
    candidate: group.candidates[0],
    request,
    workspace: { bundleId: "bundle", workspaceId: "workspace", physicalRoot: "/physical" },
    grant: candidateGrant(executionGroup, group.candidates[0]),
    signal: new AbortController().signal,
  })
}

it("runs only the child through the resolver and ordinary capture gate, without editing options", async () => {
  expect(await execute()).toEqual({
    changesetId: "change",
    headSha: "head",
    hasChanges: true,
    costUsd: null,
  })
  expect(resolve).toHaveBeenCalledWith(
    expect.objectContaining({
      capabilityGrants: [expect.objectContaining({ model: "chosen", maxBudgetUsd: 2 })],
      session: expect.objectContaining({
        workingDir: "/physical",
        workspaceConfinementEnabled: true,
      }),
      activeProject: expect.objectContaining({
        roots: [{ id: "repo", path: "/physical", isPrimary: true }],
      }),
    })
  )
  expect(run).toHaveBeenCalledWith("session", "Fix this", options, expect.any(Object))
  expect(run).toHaveBeenCalledTimes(1)
  expect(begin).toHaveBeenCalledWith(expect.objectContaining({ isolateFailure: true }))
  expect(capture).toHaveBeenCalledWith(
    expect.objectContaining({ requiredChecks: ["approved-test"], targetRef: "refs/heads/result" })
  )
  expect(settle).toHaveBeenCalledWith("ready")
})

it("records a no-change success without inventing a cost", async () => {
  capture.mockRejectedValue({ code: "nothing_to_capture" })
  expect(await execute()).toEqual({ hasChanges: false, costUsd: null })
  expect(dispatch.complete).toHaveBeenCalledWith({ text: "done" })
})

it("does not turn provider budget or turn-limit failures into publishable success", async () => {
  run.mockResolvedValue({ text: "incomplete", resultSubtype: "error_max_budget_usd" })
  await expect(execute()).rejects.toThrow("error_max_budget_usd")
  expect(capture).not.toHaveBeenCalled()
  expect(dispatch.fail).toHaveBeenCalled()
})

it.each(["ai-sdk", undefined])(
  "rejects a monetary cap when the resolved runtime is %s before sending",
  async (runtimeAdapter) => {
    resolve.mockResolvedValue({
      ...options,
      execution: runtimeAdapter ? ({ runtimeAdapter } as SendOptions["execution"]) : undefined,
    })
    await expect(execute()).rejects.toThrow("cannot enforce the best-of-N cost budget")
    expect(run).not.toHaveBeenCalled()
    expect(capture).not.toHaveBeenCalled()
  }
)

it.each([undefined, 3, Number.POSITIVE_INFINITY])(
  "rejects an absent or widened resolved per-candidate cap %s",
  async (maxBudgetUsd) => {
    resolve.mockResolvedValue({ ...options, maxBudgetUsd })
    await expect(execute()).rejects.toThrow("cannot enforce the best-of-N cost budget")
    expect(run).not.toHaveBeenCalled()
  }
)

it("keeps an AI-SDK zero wire cost unknown for duration-only attempts", async () => {
  resolve.mockResolvedValue({
    ...options,
    execution: { runtimeAdapter: "ai-sdk" } as SendOptions["execution"],
  })
  run.mockResolvedValue({ text: "done", usage: { totalCostUsd: 0 } })
  const result = await execute({ ...group, budgetPolicy: { maxDurationMs: 10_000 } })
  expect(result.costUsd).toBeNull()
  expect(dispatch.complete).toHaveBeenCalledWith(
    expect.not.objectContaining({ costUsd: expect.anything() })
  )
})

it("preserves a reported zero from the Claude SDK cost authority", async () => {
  run.mockResolvedValue({ text: "done", usage: { totalCostUsd: 0 } })
  expect((await execute()).costUsd).toBe(0)
})
