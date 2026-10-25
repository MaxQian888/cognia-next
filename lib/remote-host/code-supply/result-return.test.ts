import type { ChatSession } from "@cognia/agent-config-types"
import type { ThreadHandoffTicket } from "@cognia/agent-config-types/thread-handoff"
import type { HostFeatureManifest } from "@/lib/platform/host-feature-manifest"
import { repositoryTarget } from "@/lib/policy/action-review/outbound-targets"
import type { AppliedCodeResult, CodeResult, TransferChunk } from "@/lib/task-workspace/types"
import type { PullRequestRef } from "@/types/review"

import {
  BringBackError,
  RESULT_RETURN_LEASE_OPERATIONS,
  bringBackFailure,
  bringBackRefusal,
  bringChangesBack,
  codeResultAgent,
  handedOverCode,
  openResultPullRequest,
  resultPullRequestAvailable,
  type BringBackDeps,
  type BringBackProgress,
  type HandedOverCode,
} from "./result-return"

const RESULT_OPERATIONS = ["code_checkout_export", "code_result_read_chunk", "code_result_discard"]

function manifest(operations = RESULT_OPERATIONS): HostFeatureManifest {
  return {
    schemaVersion: 2,
    features: { "always-on.code-supply": { version: 1, operations } },
    operations: operations.map((name) => ({ name, healthy: true })),
  } as unknown as HostFeatureManifest
}

const host = { featureManifest: manifest() }

const CHECKOUT_ID = "0190e0e0-1111-7222-8333-444455556666"

const handed: HandedOverCode = {
  ticketId: "ticket-1",
  hostRef: "host-1",
  hostLabel: "Studio Mac",
  checkoutId: CHECKOUT_ID,
}

const session: ChatSession = {
  id: "session-1",
  title: "Fix login",
  createdAt: 1,
  updatedAt: 1,
  externalAgentSession: { agentId: "Claude Code", sessionId: "s" },
  handoffLock: {
    ticketId: "ticket-1",
    state: "committed",
    targetHostRef: "host-1",
    at: 2,
  },
}

function ticket(extra: Partial<ThreadHandoffTicket> = {}): ThreadHandoffTicket {
  return {
    ticketId: "ticket-1",
    role: "source",
    state: "committed",
    target: { hostRef: "host-1", kind: "desktop", label: "Studio Mac" },
    project: { codeCheckout: { checkoutId: CHECKOUT_ID } },
    ...extra,
  } as unknown as ThreadHandoffTicket
}

const bytes = "BUNDLE-BYTES-0123456789"

function result(extra: Partial<CodeResult> = {}): CodeResult {
  return {
    checkoutId: CHECKOUT_ID,
    kind: "branch",
    branch: "cognia/claude-code-444455556666",
    commit: "c".repeat(40),
    baseCommit: "b".repeat(40),
    baseRef: "main",
    remoteUrl: "https://github.com/acme/app",
    subdir: "",
    files: 3,
    pushError: null,
    transfer: null,
    ...extra,
  }
}

const bundled = result({
  kind: "bundle",
  pushError: "remote: Permission denied",
  transfer: {
    resultId: "0190e0e0-2222-7222-8333-444455556666",
    manifest: {
      kind: "git-bundle",
      sizeBytes: bytes.length,
      sha256: "a".repeat(64),
      baseCommit: "b".repeat(40),
      baseRef: "main",
      tree: "d".repeat(40),
      subdir: "",
      entries: 3,
    },
    chunkBytes: 8,
  },
})

const applied: AppliedCodeResult = {
  path: "/data/executions/returns/x",
  workingDir: "/data/executions/returns/x",
  branch: "cognia/claude-code-444455556666",
  commit: "c".repeat(40),
  reused: false,
}

function harness(
  options: { exported?: CodeResult; failReadAt?: number; committedSha?: string } = {}
) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const transport = {
    call: jest.fn(async (name: string, args: Record<string, unknown> = {}) => {
      calls.push({ name, args })
      switch (name) {
        case "code_checkout_export":
          return options.exported ?? result()
        case "code_result_read_chunk": {
          const offset = args.offset as number
          if (options.failReadAt === offset) throw new Error("connection dropped")
          const slice = bytes.slice(offset, offset + 8)
          const chunk: TransferChunk = {
            offset,
            nextOffset: offset + slice.length,
            chunkHash: `hash-${offset}`,
            dataBase64: Buffer.from(slice).toString("base64"),
            eof: offset + slice.length === bytes.length,
          }
          return chunk
        }
        case "code_result_discard":
          return null
        default:
          throw new Error(`unexpected ${name}`)
      }
    }),
  }
  const close = jest.fn()
  let received = 0
  const deps: BringBackDeps = {
    workingDirectory: jest.fn(async () => "/Users/me/app"),
    openTarget: jest.fn(async () => ({ transport, close })) as BringBackDeps["openTarget"],
    issueLease: jest.fn(async () => ({ token: "lease-1" })),
    receiveOpen: jest.fn(async () => ({
      uploadId: "recv-1",
      snapshotId: "0190e0e0-3333-7222-8333-444455556666",
      chunkBytes: 8,
      maxBytes: 1024,
    })),
    receiveWrite: jest.fn(async (input) => {
      received = input.offset + Buffer.from(input.dataBase64, "base64").length
      return received
    }),
    receiveCommit: jest.fn(async () => ({
      snapshotId: "0190e0e0-3333-7222-8333-444455556666",
      sha256: options.committedSha ?? "a".repeat(64),
      sizeBytes: bytes.length,
    })),
    receiveCancel: jest.fn(async () => {}),
    apply: jest.fn(async () => applied),
  }
  return { calls, transport, close, deps }
}

describe("handedOverCode", () => {
  it("reads the checkout from the committed source ticket", () => {
    expect(handedOverCode(session, ticket())).toEqual(handed)
  })

  it("is null for a handoff that is not committed, not this one, or without code", () => {
    expect(
      handedOverCode({ handoffLock: { ...session.handoffLock!, state: "frozen" } }, ticket())
    ).toBeNull()
    expect(handedOverCode(session, ticket({ ticketId: "other" }))).toBeNull()
    expect(handedOverCode(session, ticket({ role: "target" }))).toBeNull()
    expect(handedOverCode(session, ticket({ project: {} }))).toBeNull()
    expect(handedOverCode({}, ticket())).toBeNull()
    expect(handedOverCode(session, undefined)).toBeNull()
  })
})

describe("bringBackRefusal", () => {
  it("needs a desktop, handed-over code and a host that exports", () => {
    expect(bringBackRefusal({ handed, host, isDesktop: true })).toBeNull()
    expect(bringBackRefusal({ handed, host, isDesktop: false })).toBe("not-desktop")
    expect(bringBackRefusal({ handed: null, host, isDesktop: true })).toBe("no-code")
    expect(
      bringBackRefusal({
        handed,
        host: { featureManifest: manifest(["code_checkout_export"]) },
        isDesktop: true,
      })
    ).toBe("host-unsupported")
    expect(bringBackRefusal({ handed, host: null, isDesktop: true })).toBe("host-unsupported")
  })
})

describe("codeResultAgent", () => {
  it("names the branch after the external agent, in the host's alphabet", () => {
    expect(codeResultAgent(session)).toBe("claude-code")
    expect(codeResultAgent({ externalAgentSession: { agentId: "--Pi__", sessionId: "s" } })).toBe(
      "pi"
    )
    expect(codeResultAgent({})).toBe("cognia")
    expect(codeResultAgent({ externalAgentSession: { agentId: "!!!", sessionId: "s" } })).toBe(
      "cognia"
    )
    const long = codeResultAgent({
      externalAgentSession: { agentId: `${"a".repeat(31)}-tail`, sessionId: "s" },
    })
    expect(long).toMatch(/^[a-z0-9][a-z0-9-]{0,31}$/)
    expect(long.endsWith("-")).toBe(false)
  })
})

describe("bringChangesBack", () => {
  it("exports a pushed branch under one lease and applies it beside the original", async () => {
    const { calls, close, deps } = harness()
    const steps: BringBackProgress[] = []
    const brought = await bringChangesBack(
      session,
      handed,
      host,
      { onProgress: (step) => steps.push(step) },
      deps
    )

    expect(deps.issueLease).toHaveBeenCalledWith(
      [...RESULT_RETURN_LEASE_OPERATIONS],
      30 * 60,
      expect.anything()
    )
    expect(calls).toEqual([
      {
        name: "code_checkout_export",
        args: { input: { checkoutId: CHECKOUT_ID, agent: "claude-code" }, adminLease: "lease-1" },
      },
    ])
    expect(deps.receiveOpen).not.toHaveBeenCalled()
    expect(deps.apply).toHaveBeenCalledWith({
      root: "/Users/me/app",
      result: result(),
      receivedId: null,
    })
    expect(brought).toEqual({ result: result(), applied })
    expect(steps.map((step) => step.step)).toEqual(["approving", "export", "apply"])
    expect(close).toHaveBeenCalled()
  })

  it("downloads a bundle chunk by chunk, then discards it on the host", async () => {
    const { calls, deps } = harness({ exported: bundled })
    const steps: BringBackProgress[] = []
    await bringChangesBack(session, handed, host, { onProgress: (step) => steps.push(step) }, deps)

    const reads = calls.filter((call) => call.name === "code_result_read_chunk")
    expect(reads.map((call) => call.args.offset)).toEqual([0, 8, 16])
    expect(reads.every((call) => call.args.adminLease === "lease-1")).toBe(true)
    expect(deps.receiveOpen).toHaveBeenCalledWith(bytes.length, "a".repeat(64))
    expect(deps.receiveWrite).toHaveBeenCalledTimes(3)
    expect(deps.receiveCommit).toHaveBeenCalledWith("recv-1")
    expect(deps.apply).toHaveBeenCalledWith({
      root: "/Users/me/app",
      result: bundled,
      receivedId: "0190e0e0-3333-7222-8333-444455556666",
    })
    expect(calls.at(-1)).toEqual({
      name: "code_result_discard",
      args: { resultId: bundled.transfer!.resultId, adminLease: "lease-1" },
    })
    expect(steps.at(-2)).toEqual({
      step: "download",
      receivedBytes: bytes.length,
      totalBytes: bytes.length,
    })
  })

  it("cancels the receive and still discards on the host when a read fails", async () => {
    const { calls, deps } = harness({ exported: bundled, failReadAt: 8 })
    await expect(bringChangesBack(session, handed, host, {}, deps)).rejects.toThrow(
      "connection dropped"
    )
    expect(deps.receiveCancel).toHaveBeenCalledWith("recv-1")
    expect(deps.apply).not.toHaveBeenCalled()
    expect(calls.at(-1)?.name).toBe("code_result_discard")
  })

  it("refuses bytes whose whole-file hash is not the host's", async () => {
    const { deps } = harness({ exported: bundled, committedSha: "f".repeat(64) })
    const error = await bringChangesBack(session, handed, host, {}, deps).catch((e) => e)
    expect(error).toBeInstanceOf(BringBackError)
    expect(bringBackFailure(error)).toBe("integrity")
    expect(deps.apply).not.toHaveBeenCalled()
  })

  it("refuses before opening anything when it cannot run", async () => {
    const { deps } = harness()
    await expect(bringChangesBack(session, null, host, {}, deps)).rejects.toMatchObject({
      code: "no-code",
    })
    deps.workingDirectory = jest.fn(async () => undefined)
    await expect(bringChangesBack(session, handed, host, {}, deps)).rejects.toMatchObject({
      code: "no-working-directory",
    })
    expect(deps.openTarget).not.toHaveBeenCalled()
  })
})

describe("bringBackFailure", () => {
  it("maps each host and device error to something the person can act on", () => {
    const named = (name: string) => Object.assign(new Error("x"), { name })
    expect(bringBackFailure(named("HostConsentRequiredError"))).toBe("consent")
    expect(bringBackFailure(new Error("code_result_unchanged: nothing"))).toBe("unchanged")
    expect(bringBackFailure(new Error("code_result_not_found: no checkout"))).toBe("checkout-gone")
    expect(bringBackFailure(new Error("code_result_fetch_failed: auth"))).toBe("fetch-failed")
    expect(bringBackFailure(new Error("code_result_base_missing: x"))).toBe("fetch-failed")
    expect(bringBackFailure(new Error("code_result_mismatch: x"))).toBe("mismatch")
    expect(bringBackFailure(new Error("code_result_not_git: x"))).toBe("not-git")
    expect(bringBackFailure(new Error("code_snapshot_too_large: x"))).toBe("too-large")
    expect(bringBackFailure(new BringBackError("download-stalled"))).toBe("integrity")
    expect(bringBackFailure(new BringBackError("no-working-directory"))).toBe(
      "no-working-directory"
    )
    expect(bringBackFailure("boom")).toBe("other")
  })
})

describe("pull requests for work that came back", () => {
  const pr = { number: 7, url: "https://github.com/acme/app/pull/7" } as PullRequestRef

  function provider(state: "authenticated" | "unauthenticated" = "authenticated") {
    return {
      getAuthenticationState: jest.fn(async () => state),
      findForBranch: jest.fn(async () => null as PullRequestRef | null),
      push: jest.fn(async () => {}),
      create: jest.fn(async () => pr),
    }
  }

  it("is offered for git work with a base branch and a credential", async () => {
    expect(await resultPullRequestAvailable({ result: result(), applied }, provider())).toBe(true)
    expect(
      await resultPullRequestAvailable({ result: result(), applied }, provider("unauthenticated"))
    ).toBe(false)
    expect(
      await resultPullRequestAvailable({ result: result({ baseRef: null }), applied }, provider())
    ).toBe(false)
    expect(
      await resultPullRequestAvailable(
        { result: result({ kind: "tar" }), applied: { ...applied, branch: null } },
        provider()
      )
    ).toBe(false)
    const failing = provider()
    failing.getAuthenticationState.mockRejectedValueOnce(new Error("offline"))
    expect(await resultPullRequestAvailable({ result: result(), applied }, failing)).toBe(false)
  })

  it("opens a draft from the pushed branch without pushing again", async () => {
    const forge = provider()
    const record = jest.fn(async () => {
      expect(forge.create).not.toHaveBeenCalled()
    })
    const opened = await openResultPullRequest(
      { result: result(), applied: { ...applied, branch: "cognia/claude-code-444455556666-2" } },
      { title: "Fix login", body: "From the host" },
      forge,
      {
        sessionId: "s1",
        resolveRepository: async () => ({ fullName: "acme/web", host: { id: "github.com" } }),
        record,
      }
    )
    expect(record).toHaveBeenCalledWith({
      targets: [repositoryTarget("acme/web")],
      operation: "github.openPr",
      surface: "handoff",
      sessionId: "s1",
    })
    expect(opened).toBe(pr)
    expect(forge.push).not.toHaveBeenCalled()
    expect(forge.create).toHaveBeenCalledWith({
      repositoryRoot: applied.path,
      headRef: "cognia/claude-code-444455556666",
      baseRef: "main",
      title: "Fix login",
      body: "From the host",
      draft: true,
    })
  })

  it("pushes a bundle's local branch first, and reuses an open pull request", async () => {
    const forge = provider()
    forge.findForBranch.mockResolvedValueOnce(pr)
    const record = jest.fn(async () => {
      // On record before the push.
      expect(forge.push).not.toHaveBeenCalled()
    })
    const opened = await openResultPullRequest(
      { result: bundled, applied },
      { title: "t", body: "b" },
      forge,
      { resolveRepository: async () => null, record }
    )
    // A repository that cannot be named is still recorded, as unknown.
    expect(record).toHaveBeenCalledWith({
      targets: [undefined],
      operation: "github.openPr",
      surface: "handoff",
    })
    expect(forge.push).toHaveBeenCalledWith(applied.path, applied.branch)
    expect(forge.findForBranch).toHaveBeenCalledWith(applied.path, applied.branch)
    expect(forge.create).not.toHaveBeenCalled()
    expect(opened).toBe(pr)
  })

  it("refuses work without a branch to propose", async () => {
    const record = jest.fn()
    await expect(
      openResultPullRequest(
        { result: result({ kind: "tar" }), applied: { ...applied, branch: null } },
        { title: "t", body: "b" },
        provider(),
        { record }
      )
    ).rejects.toThrow("code_result_no_pull_request")
    expect(record).not.toHaveBeenCalled()
  })
})
