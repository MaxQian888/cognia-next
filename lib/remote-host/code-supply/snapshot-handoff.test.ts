import type { ChatSession } from "@cognia/agent-config-types"
import type { ThreadHandoffTicket } from "@cognia/agent-config-types/thread-handoff"
import type { HostFeatureManifest } from "@/lib/platform/host-feature-manifest"
import type { CodeCheckout, CreatedCodeSnapshot, TransferChunk } from "@/lib/task-workspace/types"
import type { Project } from "@/types"

import {
  ContinueOnHostError,
  SNAPSHOT_HANDOFF_LEASE_OPERATIONS,
  continueOnHostFailure,
  continueOnHostRefusal,
  continueSessionOnAlwaysOnHost,
  snapshotKindFor,
  type ContinueOnHostProgress,
  type SnapshotHandoffDeps,
} from "./snapshot-handoff"

const CODE_OPERATIONS = [
  "project_mutate",
  "code_snapshot_limits_get",
  "code_snapshot_upload_open",
  "code_snapshot_upload_write_chunk",
  "code_snapshot_upload_commit",
  "code_snapshot_upload_cancel",
  "code_snapshot_apply",
]

function manifest(codeOperations = CODE_OPERATIONS): HostFeatureManifest {
  const operations = [...codeOperations, "thread_handoff_accept", "thread_handoff_commit"]
  return {
    schemaVersion: 2,
    features: {
      "always-on.code-supply": { version: 1, operations: codeOperations },
      "session.thread-handoff": {
        version: 1,
        operations: ["thread_handoff_accept", "thread_handoff_commit"],
      },
    },
    operations: operations.map((name) => ({ name, healthy: true })),
  } as unknown as HostFeatureManifest
}

const host = { id: "host-1", label: "Studio Mac", featureManifest: manifest() }

const session: ChatSession = {
  id: "session-1",
  title: "Fix login",
  createdAt: 1,
  updatedAt: 1,
  projectId: "project-app",
}

const repository = { remoteUrl: "https://github.com/acme/app.git", capturedAt: 7 }

function project(extra: Partial<Project> = {}): Project {
  return {
    id: "project-app",
    name: "App",
    roots: [{ id: "r1", path: "/Users/me/app", isPrimary: true }],
    repository,
    knowledgeBase: [],
    sessionIds: [],
    sessionCount: 0,
    messageCount: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    lastAccessedAt: new Date(0),
    ...extra,
  } as Project
}

const bytes = "PATCH-BYTES-0123456789"

const created: CreatedCodeSnapshot = {
  snapshotId: "0190e0e0-0000-7000-8000-00000000aaaa",
  manifest: {
    kind: "git-patch",
    sizeBytes: bytes.length,
    sha256: "a".repeat(64),
    baseCommit: "b".repeat(40),
    baseRef: "main",
    tree: "c".repeat(40),
    subdir: "",
    entries: 3,
  },
  chunkBytes: 8,
}

const checkout: CodeCheckout = {
  checkoutId: "0190e0e0-1111-7222-8333-444455556666",
  root: "/srv/executions/handoffs/0190e0e0-1111-7222-8333-444455556666",
  workingDir: "/srv/executions/handoffs/0190e0e0-1111-7222-8333-444455556666",
  kind: "git-patch",
  branch: "cognia/handoff-444455556666",
  baseCommit: "b".repeat(40),
  projectId: "project-app",
  remoteUrl: repository.remoteUrl,
  createdAt: 1,
}

function harness(options: { project?: Project; failWriteAt?: number; committedSha?: string } = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  let written = 0
  const transport = {
    call: jest.fn(async (name: string, args: Record<string, unknown> = {}) => {
      calls.push({ name, args })
      switch (name) {
        case "code_snapshot_limits_get":
          return { maxBytes: 1024, chunkBytes: 8 }
        case "project_mutate":
          return { id: "project-app", created: true }
        case "code_snapshot_upload_open":
          return { uploadId: "up-1", snapshotId: "host-snap", chunkBytes: 8, maxBytes: 1024 }
        case "code_snapshot_upload_write_chunk": {
          if (options.failWriteAt !== undefined && args.offset === options.failWriteAt) {
            throw new Error("connection dropped")
          }
          written =
            (args.offset as number) + Buffer.from(args.dataBase64 as string, "base64").length
          return written
        }
        case "code_snapshot_upload_commit":
          return {
            snapshotId: "host-snap",
            sha256: options.committedSha ?? created.manifest.sha256,
            sizeBytes: written,
          }
        case "code_snapshot_upload_cancel":
          return null
        case "code_snapshot_apply":
          return checkout
        default:
          throw new Error(`unexpected ${name}`)
      }
    }),
  }
  const close = jest.fn()
  const ticket = { ticketId: "t-1", state: "committed" } as ThreadHandoffTicket
  const deps: SnapshotHandoffDeps = {
    workingDirectory: jest.fn(async () => "/Users/me/app"),
    project: jest.fn(async () => options.project ?? project()),
    openTarget: jest.fn(async () => ({
      transport: transport as unknown as { call<T>(name: string, args?: object): Promise<T> },
      close,
    })) as SnapshotHandoffDeps["openTarget"],
    issueLease: jest.fn(async () => ({ token: "lease-1" })),
    createSnapshot: jest.fn(async () => created),
    readChunk: jest.fn(async (_id: string, offset: number): Promise<TransferChunk> => {
      const slice = bytes.slice(offset, offset + 8)
      return {
        offset,
        nextOffset: offset + slice.length,
        dataBase64: Buffer.from(slice).toString("base64"),
        chunkHash: "h",
        eof: offset + slice.length === bytes.length,
      }
    }),
    discardSnapshot: jest.fn(async () => {}),
    startHandoff: jest.fn(async () => ticket),
  }
  return { calls, deps, close, ticket }
}

describe("continueOnHostRefusal", () => {
  const base = { session, host, isDesktop: true }

  it("lets a desktop conversation go to a host that has every operation", () => {
    expect(continueOnHostRefusal(base)).toBeNull()
  })

  it("names why it cannot", () => {
    expect(continueOnHostRefusal({ ...base, isDesktop: false })).toBe("not-desktop")
    expect(continueOnHostRefusal({ ...base, host: null })).toBe("no-host")
    expect(
      continueOnHostRefusal({ ...base, session: { ...session, collaboration: {} as never } })
    ).toBe("shared")
    expect(continueOnHostRefusal({ ...base, session: { ...session, archivedAt: 5 } })).toBe(
      "archived"
    )
    expect(
      continueOnHostRefusal({
        ...base,
        session: {
          ...session,
          handoffLock: { ticketId: "t", state: "frozen", at: 1 },
        },
      })
    ).toBe("in-handoff")
    expect(
      continueOnHostRefusal({
        ...base,
        host: { featureManifest: manifest(["project_mutate"]) },
      })
    ).toBe("host-unsupported")
  })
})

describe("snapshotKindFor", () => {
  it("sends a patch only when the host can fetch the base", () => {
    expect(snapshotKindFor({ repository })).toBeUndefined()
    expect(snapshotKindFor({ repository: undefined })).toBe("tar")
    expect(snapshotKindFor(null)).toBe("tar")
  })
})

describe("continueSessionOnAlwaysOnHost", () => {
  it("hands over the workspace, the code and then the conversation, under one lease", async () => {
    const { calls, deps, close, ticket } = harness()
    const progress: ContinueOnHostProgress[] = []
    const result = await continueSessionOnAlwaysOnHost(
      session,
      host,
      { onProgress: (step) => progress.push(step) },
      deps
    )

    expect(result).toEqual({ ticket, checkout })
    expect(deps.issueLease).toHaveBeenCalledWith(
      [...SNAPSHOT_HANDOFF_LEASE_OPERATIONS],
      expect.any(Number),
      expect.anything()
    )
    expect(deps.createSnapshot).toHaveBeenCalledWith({ root: "/Users/me/app", maxBytes: 1024 })
    expect(calls.map((entry) => entry.name)).toEqual([
      "code_snapshot_limits_get",
      "project_mutate",
      "code_snapshot_upload_open",
      "code_snapshot_upload_write_chunk",
      "code_snapshot_upload_write_chunk",
      "code_snapshot_upload_write_chunk",
      "code_snapshot_upload_commit",
      "code_snapshot_apply",
    ])
    for (const entry of calls.slice(1)) expect(entry.args.adminLease).toBe("lease-1")
    expect(calls.at(-1)?.args.input).toEqual({
      snapshotId: "host-snap",
      manifest: created.manifest,
      projectId: "project-app",
      roots: ["/Users/me/app"],
      remoteUrl: repository.remoteUrl,
    })
    expect(deps.startHandoff).toHaveBeenCalledWith(
      session,
      { hostRef: "host-1", kind: "desktop", label: "Studio Mac" },
      { codeCheckout: { checkoutId: checkout.checkoutId }, adminLease: "lease-1" }
    )
    expect(deps.discardSnapshot).toHaveBeenCalledWith(created.snapshotId)
    expect(close).toHaveBeenCalledTimes(1)
    expect(progress.map((entry) => entry.step)).toEqual([
      "approving",
      "snapshot",
      "workspace",
      "upload",
      "upload",
      "upload",
      "upload",
      "apply",
      "conversation",
    ])
    expect(progress.filter((entry) => entry.step === "upload").at(-1)).toEqual({
      step: "upload",
      sentBytes: bytes.length,
      totalBytes: bytes.length,
    })
  })

  it("sends a workspace without a repository as files", async () => {
    const { deps, calls } = harness({ project: project({ repository: undefined }) })
    await continueSessionOnAlwaysOnHost(session, host, {}, deps)
    expect(deps.createSnapshot).toHaveBeenCalledWith({
      root: "/Users/me/app",
      maxBytes: 1024,
      kind: "tar",
    })
    const copy = calls.find((entry) => entry.name === "project_mutate")?.args.project
    expect(copy).not.toHaveProperty("repository")
  })

  it("cancels the upload, discards the snapshot and leaves the conversation when a chunk fails", async () => {
    const { deps, calls, close } = harness({ failWriteAt: 8 })
    await expect(continueSessionOnAlwaysOnHost(session, host, {}, deps)).rejects.toThrow(
      "connection dropped"
    )
    expect(calls.map((entry) => entry.name)).toContain("code_snapshot_upload_cancel")
    expect(calls.map((entry) => entry.name)).not.toContain("code_snapshot_apply")
    expect(deps.discardSnapshot).toHaveBeenCalled()
    expect(deps.startHandoff).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalled()
  })

  it("refuses an upload the host committed as different bytes", async () => {
    const { deps } = harness({ committedSha: "f".repeat(64) })
    await expect(continueSessionOnAlwaysOnHost(session, host, {}, deps)).rejects.toMatchObject({
      code: "integrity-failed",
    })
    expect(deps.startHandoff).not.toHaveBeenCalled()
  })

  it("needs a working directory, and refuses before touching the host otherwise", async () => {
    const { deps } = harness()
    ;(deps.workingDirectory as jest.Mock).mockResolvedValueOnce(undefined)
    await expect(continueSessionOnAlwaysOnHost(session, host, {}, deps)).rejects.toBeInstanceOf(
      ContinueOnHostError
    )
    expect(deps.openTarget).not.toHaveBeenCalled()

    await expect(
      continueSessionOnAlwaysOnHost({ ...session, archivedAt: 1 }, host, {}, deps)
    ).rejects.toMatchObject({ code: "archived" })
  })
})

describe("continueOnHostFailure", () => {
  it("names each failure the person can act on", () => {
    const consent = new Error("needs approval")
    consent.name = "HostConsentRequiredError"
    expect(continueOnHostFailure(consent)).toBe("consent")
    expect(continueOnHostFailure(new ContinueOnHostError("no-working-directory"))).toBe(
      "no-working-directory"
    )
    expect(continueOnHostFailure(new ContinueOnHostError("integrity-failed"))).toBe("integrity")
    for (const [message, expected] of [
      ["rpc failed: code_snapshot_too_large: more than 100 MiB", "too-large"],
      ["code_snapshot_no_remote: the repository has no remote", "no-remote"],
      ["project_source_unavailable: none of this project's folders", "no-remote"],
      ["code_snapshot_base_unavailable: push it, then try again", "base-unavailable"],
      ["code_snapshot_tree_mismatch: tree x", "tree-mismatch"],
      ["code_snapshot_unsafe_archive: ../x leaves the checkout", "unsafe-archive"],
      ["code_snapshot_integrity_failed: the uploaded bytes", "integrity"],
      ["socket closed", "other"],
    ] as const) {
      expect(continueOnHostFailure(new Error(message))).toBe(expected)
    }
  })
})
