import {
  GITHUB_DELIVERY_PLUGIN_ID,
  GITHUB_INTEGRATION_ID,
  GithubWritebackError,
  resolveGithubWritebackAccount,
  runGithubWriteback,
  toIntegrationAction,
} from "./github-writeback"
import type { IntegrationAccount, IntegrationActionJob } from "@/types/plugin/plugin-integration"

const mockListAccounts = jest.fn()
jest.mock("@/lib/db/integrations", () => ({
  listIntegrationAccounts: (...args: unknown[]) => mockListAccounts(...args),
}))

jest.mock("@/lib/integrations/action-runner", () => ({
  executeIntegrationAction: jest.fn(),
  approveIntegrationActionJob: jest.fn(),
}))

const account = (over: Partial<IntegrationAccount> = {}): IntegrationAccount =>
  ({
    id: "acct-1",
    pluginId: GITHUB_DELIVERY_PLUGIN_ID,
    integrationId: GITHUB_INTEGRATION_ID,
    enabled: true,
    label: "acme (PAT)",
    ...over,
  }) as IntegrationAccount

const job = (over: Partial<IntegrationActionJob> = {}): IntegrationActionJob =>
  ({ id: "job-1", status: "awaiting_approval", ...over }) as IntegrationActionJob

const target = { repoFullName: "acme/one", number: 7 }

beforeEach(() => jest.clearAllMocks())

describe("toIntegrationAction", () => {
  it("maps a comment onto the plugin's commentIssue contract", () => {
    expect(toIntegrationAction(target, { kind: "comment", body: "hi" })).toEqual({
      actionId: "commentIssue",
      input: { repoFullName: "acme/one", issueNumber: 7, body: "hi" },
    })
  })

  it("copies the labels array so a frozen caller value can't leak through", () => {
    const labels = Object.freeze(["bug", "p1"])
    const mapped = toIntegrationAction(target, { kind: "label", labels })
    expect(mapped).toEqual({
      actionId: "labelIssue",
      input: { repoFullName: "acme/one", issueNumber: 7, labels: ["bug", "p1"] },
    })
    expect(mapped.input.labels).not.toBe(labels)
  })

  it("defaults a close to `completed` rather than leaving GitHub to guess", () => {
    expect(toIntegrationAction(target, { kind: "close" }).input).toMatchObject({
      reason: "completed",
    })
  })

  it("preserves an explicit not_planned close — it is a different outcome", () => {
    expect(
      toIntegrationAction(target, { kind: "close", reason: "not_planned" }).input
    ).toMatchObject({ reason: "not_planned" })
  })
})

describe("resolveGithubWritebackAccount", () => {
  it("picks the first enabled account (newest, by the query's own ordering)", async () => {
    mockListAccounts.mockResolvedValue([account({ id: "new" }), account({ id: "old" })])

    await expect(resolveGithubWritebackAccount()).resolves.toMatchObject({ id: "new" })
    expect(mockListAccounts).toHaveBeenCalledWith(GITHUB_DELIVERY_PLUGIN_ID, GITHUB_INTEGRATION_ID)
  })

  it("skips disabled accounts", async () => {
    mockListAccounts.mockResolvedValue([
      account({ id: "off", enabled: false }),
      account({ id: "on" }),
    ])

    await expect(resolveGithubWritebackAccount()).resolves.toMatchObject({ id: "on" })
  })

  it("returns null when nothing is connected", async () => {
    mockListAccounts.mockResolvedValue([])
    await expect(resolveGithubWritebackAccount()).resolves.toBeNull()
  })
})

describe("runGithubWriteback", () => {
  it("refuses with an actionable code when no account is connected", async () => {
    const execute = jest.fn()
    await expect(
      runGithubWriteback(
        { target, action: { kind: "comment", body: "hi" } },
        { resolveAccount: async () => null, execute }
      )
    ).rejects.toMatchObject({ name: "GithubWritebackError", code: "no-account" })
    expect(execute).not.toHaveBeenCalled()
  })

  it("routes through the github-delivery plugin, not a new write path", async () => {
    const execute = jest.fn().mockResolvedValue(job({ status: "succeeded" }))
    await runGithubWriteback(
      { target, action: { kind: "comment", body: "hi" }, idempotencyKey: "k1" },
      { resolveAccount: async () => account(), execute }
    )

    expect(execute).toHaveBeenCalledWith(GITHUB_DELIVERY_PLUGIN_ID, {
      integrationId: GITHUB_INTEGRATION_ID,
      accountId: "acct-1",
      actionId: "commentIssue",
      input: { repoFullName: "acme/one", issueNumber: 7, body: "hi" },
      source: "manual",
      idempotencyKey: "k1",
    })
  })

  it("omits idempotencyKey entirely when the caller has none", async () => {
    const execute = jest.fn().mockResolvedValue(job({ status: "succeeded" }))
    await runGithubWriteback(
      { target, action: { kind: "close" } },
      { resolveAccount: async () => account(), execute }
    )

    expect(execute.mock.calls[0][1]).not.toHaveProperty("idempotencyKey")
  })

  it("LEAVES the job parked when the caller has not confirmed", async () => {
    const execute = jest.fn().mockResolvedValue(job())
    const approve = jest.fn()

    const result = await runGithubWriteback(
      { target, action: { kind: "close" } },
      { resolveAccount: async () => account(), execute, approve }
    )

    // An irreversible external write must never happen without confirmation.
    expect(approve).not.toHaveBeenCalled()
    expect(result.status).toBe("awaiting_approval")
  })

  it("approves only once the dialog has confirmed the exact payload", async () => {
    const execute = jest.fn().mockResolvedValue(job())
    const approve = jest.fn().mockResolvedValue(job({ status: "succeeded" }))

    const result = await runGithubWriteback(
      { target, action: { kind: "close" }, approval: "user-confirmed" },
      { resolveAccount: async () => account(), execute, approve }
    )

    expect(approve).toHaveBeenCalledWith("job-1")
    expect(result.status).toBe("succeeded")
  })

  it("does not re-approve a job that never needed approval", async () => {
    const execute = jest.fn().mockResolvedValue(job({ status: "succeeded" }))
    const approve = jest.fn()

    await runGithubWriteback(
      { target, action: { kind: "comment", body: "hi" }, approval: "user-confirmed" },
      { resolveAccount: async () => account(), execute, approve }
    )

    expect(approve).not.toHaveBeenCalled()
  })

  it("translates an unregistered plugin into a code the UI can explain", async () => {
    const execute = jest.fn().mockRejectedValue(new Error('Integration "github" is not registered'))

    await expect(
      runGithubWriteback(
        { target, action: { kind: "comment", body: "hi" } },
        { resolveAccount: async () => account(), execute }
      )
    ).rejects.toMatchObject({ code: "plugin-unavailable" })
  })

  it("keeps a non-Error rejection readable", async () => {
    const execute = jest.fn().mockRejectedValue("blocked by the PII gate")

    await expect(
      runGithubWriteback(
        { target, action: { kind: "comment", body: "hi" } },
        { resolveAccount: async () => account(), execute }
      )
    ).rejects.toMatchObject({ message: "blocked by the PII gate" })
  })

  it("stays recognisable through instanceof", async () => {
    const error = await runGithubWriteback(
      { target, action: { kind: "close" } },
      { resolveAccount: async () => null }
    ).catch((cause) => cause)

    expect(error).toBeInstanceOf(GithubWritebackError)
  })
})
