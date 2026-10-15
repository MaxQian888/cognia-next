const buildUtilityLlmClient = jest.fn(() => ({ complete: jest.fn(async () => "[]") }))
jest.mock("@/lib/ai/generation/utility-client", () => ({
  buildUtilityLlmClient: (...args: unknown[]) => buildUtilityLlmClient(...(args as [])),
}))

const gitStatus = jest.fn()
const gitBranches = jest.fn()
const gitCreateBranch = jest.fn(async () => undefined)
jest.mock("@/lib/git/commands", () => ({
  gitStatus: (...a: unknown[]) => gitStatus(...a),
  gitBranches: (...a: unknown[]) => gitBranches(...a),
  gitCreateBranch: (...a: unknown[]) => gitCreateBranch(...(a as [])),
  gitDiffRefsFile: jest.fn(),
  gitReadBlobAtRef: jest.fn(async () => null),
}))

const createDelegateAcceptancePort = jest.fn(
  (input: { rootForRevision: (r: string) => Promise<string | null> }) => ({
    runProfile: async () => ({ kind: "refused", code: "X", message: "x" }),
    input,
  })
)
jest.mock("@/lib/router-fusion/verify/code-acceptance-host", () => ({
  createDelegateAcceptancePort: (input: never) => createDelegateAcceptancePort(input),
  defaultAcceptanceSandboxHost: jest.fn(() => ({})),
  resolveProjectContainerImage: jest.fn(async () => null),
}))
jest.mock("@/lib/router-fusion/runtime/delegate-host-ports", () => ({
  acceptanceProfileResolver: jest.fn(() => async () => ({
    ok: false,
    code: "MISSING",
    message: "m",
  })),
}))

const reviewChangeset = jest.fn(async () => ({
  changeset: {},
  policy: null,
  risk: null,
  agent: null,
  checks: [],
}))
jest.mock("./review/review-changeset", () => ({
  ...jest.requireActual("./review/review-changeset"),
  reviewChangeset: (...a: unknown[]) => reviewChangeset(...(a as [])),
}))
const integrateChangesets = jest.fn(async () => ({ kind: "published" }))
jest.mock("./integration/orchestrator", () => ({
  ...jest.requireActual("./integration/orchestrator"),
  integrateChangesets: (...a: unknown[]) => integrateChangesets(...(a as [])),
}))

import type { ScmHost } from "./host"
import { createScmRuntime, reviewClientFor, scmGitPortsFor } from "./runtime"

const changeset = { changesetId: "cs-1", headSha: "h1", executionRoot: "/data/ws-1" }
const host = { getChangeset: jest.fn(async () => changeset) } as unknown as ScmHost
const signal = new AbortController().signal

beforeEach(() => jest.clearAllMocks())

describe("reviewClientFor", () => {
  it("uses the Source Control panel's AI-review model choice when AI review is on", () => {
    reviewClientFor({
      gitSettings: { reviewAI: { enabled: true, model: "m1", providerOverride: "p1" } },
    } as never)
    expect(buildUtilityLlmClient).toHaveBeenCalledWith(
      expect.objectContaining({
        session: null,
        override: { providerOverride: "p1", model: "m1" },
        featureId: "scm.reviewChangeset",
      })
    )
  })

  it("has no reviewer while AI review is off, its default", () => {
    expect(
      reviewClientFor({ gitSettings: { reviewAI: { enabled: false, model: "m1" } } } as never)
    ).toBeNull()
    expect(reviewClientFor(null)).toBeNull()
    expect(buildUtilityLlmClient).not.toHaveBeenCalled()
  })
})

describe("createScmRuntime", () => {
  it("reviews with the project's acceptance port bound to the changeset's head", async () => {
    const runtime = createScmRuntime({ projectId: "project-1", appSettings: null, host })
    await runtime.review("cs-1", signal)
    const [, deps] = reviewChangeset.mock.calls[0] as unknown as [
      string,
      { acceptancePort: unknown; host: unknown },
    ]
    expect(deps.host).toBe(host)
    expect(deps.acceptancePort).not.toBeNull()
    const { input } = createDelegateAcceptancePort.mock.results[0].value as {
      input: { rootForRevision: (r: string) => Promise<string | null>; runId: string }
    }
    expect(input.runId).toBe("changeset:cs-1")
    await expect(input.rootForRevision("h1")).resolves.toBe("/data/ws-1")
    await expect(input.rootForRevision("other")).resolves.toBeNull()
  })

  it("runs no checks without a project, so required checks stay shut", async () => {
    const runtime = createScmRuntime({ projectId: null, appSettings: null, host })
    await runtime.review("cs-1", signal)
    const [, deps] = reviewChangeset.mock.calls[0] as unknown as [
      string,
      { acceptancePort: unknown },
    ]
    expect(deps.acceptancePort).toBeNull()
    expect(createDelegateAcceptancePort).not.toHaveBeenCalled()

    await runtime.integrate({ changesetIds: [], targetRef: "refs/heads/main" } as never)
    const [, integrationDeps] = integrateChangesets.mock.calls[0] as unknown as [
      unknown,
      { acceptancePortFor: unknown },
    ]
    expect(integrationDeps.acceptancePortFor).toBeNull()
  })

  it("verifies an integration candidate in the run's own worktree", async () => {
    const runtime = createScmRuntime({ projectId: "project-1", appSettings: null, host })
    await runtime.integrate({ changesetIds: ["cs-1"], targetRef: "refs/heads/main" } as never)
    const [, deps] = integrateChangesets.mock.calls[0] as unknown as [
      unknown,
      { acceptancePortFor: (run: unknown) => unknown },
    ]
    deps.acceptancePortFor({
      integrationId: "int-1",
      candidateSha: "c1",
      worktreePath: "/data/integration/k",
    })
    const { input } = createDelegateAcceptancePort.mock.results[0].value as {
      input: { rootForRevision: (r: string) => Promise<string | null>; runId: string }
    }
    expect(input.runId).toBe("integration:int-1")
    await expect(input.rootForRevision("c1")).resolves.toBe("/data/integration/k")
  })
})

describe("scmGitPortsFor", () => {
  it("reads the current branch, finds only local branches, and creates without checkout", async () => {
    const scmGitPorts = scmGitPortsFor()
    gitStatus.mockResolvedValueOnce({ branch: "main" })
    await expect(scmGitPorts.currentBranch("/repo")).resolves.toBe("main")
    gitBranches.mockResolvedValue([
      { name: "agent/run/integrated", isRemote: true },
      { name: "feature", isRemote: false },
    ])
    await expect(scmGitPorts.branchExists("/repo", "agent/run/integrated")).resolves.toBe(false)
    await expect(scmGitPorts.branchExists("/repo", "feature")).resolves.toBe(true)
    await scmGitPorts.createBranch("/repo", "agent/run/integrated", "HEAD")
    expect(gitCreateBranch).toHaveBeenCalledWith("/repo", "agent/run/integrated", false, "HEAD")
  })
})
