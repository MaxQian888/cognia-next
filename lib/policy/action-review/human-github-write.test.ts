import { outboundFingerprint, repositoryTarget, unknownGithubTarget } from "./outbound-targets"
import { recordHumanGithubWrite } from "./human-github-write"

const enforce = { agentPermissions: { outboundAuthorizationByCategory: { github: "enforce" } } }

describe("recordHumanGithubWrite", () => {
  it("records a human receipt naming the repositories and the surface", async () => {
    const project = jest.fn(async () => undefined)
    await recordHumanGithubWrite(
      {
        targets: [repositoryTarget("acme/web"), repositoryTarget("acme/api")],
        operation: "github.publishStack",
        surface: "stack-panel",
      },
      { plan: { settings: () => enforce, now: () => 5 }, project }
    )
    expect(project).toHaveBeenCalledTimes(1)
    const [request, decision] = project.mock.calls[0] as unknown as [
      Record<string, never>,
      Record<string, never>,
    ]
    expect(request).toMatchObject({
      origin: { channel: "github-delivery" },
      subject: {
        kind: "integration-action",
        ref: "person:stack-panel",
        title: "github.publishStack",
        targets: [
          { channel: "github", fingerprint: outboundFingerprint(repositoryTarget("acme/web")!) },
          { channel: "github", fingerprint: outboundFingerprint(repositoryTarget("acme/api")!) },
        ],
      },
      plan: { outcome: "allow", enforced: true },
    })
    expect(decision).toMatchObject({
      outcome: "allow",
      authority: "human",
      grant: { scope: "once" },
      actor: { kind: "local-user" },
    })
  })

  it("records an unnamed repository as unknown, and says shadow mode", async () => {
    const project = jest.fn(async () => undefined)
    await recordHumanGithubWrite(
      { targets: [undefined], operation: "github.openPr", surface: "handoff" },
      { plan: { settings: () => ({ agentPermissions: {} }) }, project }
    )
    const [request] = project.mock.calls[0] as unknown as [Record<string, never>]
    expect(request).toMatchObject({
      subject: {
        targets: [{ channel: "github", fingerprint: outboundFingerprint(unknownGithubTarget()) }],
      },
      plan: { enforced: false },
    })
  })

  it("files the receipt under the session's request", async () => {
    const project = jest.fn(async () => undefined)
    await recordHumanGithubWrite(
      {
        targets: [repositoryTarget("acme/web")],
        operation: "github.mergePr",
        surface: "thread-pr",
        sessionId: "s1",
      },
      {
        plan: {
          settings: () => enforce,
          resolveSessionOrigin: async () => ({ rootSessionId: "root-1", instructionEpoch: "e1" }),
        },
        project,
      }
    )
    const [request] = project.mock.calls[0] as unknown as [Record<string, never>]
    expect(request).toMatchObject({
      origin: { sessionId: "s1", rootSessionId: "root-1", instructionEpoch: "e1" },
    })
  })

  it("never throws", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined)
    await expect(
      recordHumanGithubWrite(
        { targets: [repositoryTarget("acme/web")], operation: "x", surface: "y" },
        {
          plan: { settings: () => enforce },
          project: async () => {
            throw new Error("db closed")
          },
        }
      )
    ).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
