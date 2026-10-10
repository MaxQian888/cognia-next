jest.mock("@/lib/collab/shared-session-access", () => {
  class SharedSessionAccessError extends Error {
    constructor(readonly reason: string) {
      super(reason)
    }
  }
  return { SharedSessionAccessError, assertSharedSessionFileShare: jest.fn() }
})
jest.mock("@/lib/share/client", () => ({ createShareLink: jest.fn() }))
jest.mock("./policy", () => ({
  ...jest.requireActual("./policy"),
  loadEffectiveFileSharingPolicy: jest.fn(),
}))

import { SharedSessionAccessError } from "@/lib/collab/shared-session-access"
import type { ShareFileCandidate } from "@/lib/share/file-selection"
import type { FileSpacePath } from "@/types/filespace"

import { DEFAULT_FILE_SHARING_POLICY } from "./policy"
import { FileShareRefusedError, createFileShare, type CreateFileShareDeps } from "./share-files"

const PAYLOAD = {
  kind: "file-bundle" as const,
  mime: "application/json",
  data: "",
  encoding: "utf8" as const,
}

function candidate(path: string, sensitive = false): ShareFileCandidate {
  return {
    path: path as FileSpacePath,
    name: path.slice(path.lastIndexOf("/") + 1),
    mime: "text/plain",
    size: 3,
    sensitive,
    open: jest.fn(),
  }
}

const binding = {
  orgId: "org",
  workspaceId: "ws",
  sessionId: "remote",
  policyRevision: 1,
  syncCursor: 0,
}

function deps(overrides: Partial<CreateFileShareDeps> = {}): CreateFileShareDeps & {
  createShareLink: jest.Mock
  loadPolicy: jest.Mock
  authorizeSharedSession: jest.Mock
} {
  return {
    authorizeSharedSession: jest.fn(async () => null),
    loadPolicy: jest.fn(async () => ({
      policy: { ...DEFAULT_FILE_SHARING_POLICY, maxSnapshotTtlSeconds: 86_400 },
      local: DEFAULT_FILE_SHARING_POLICY,
    })),
    createShareLink: jest.fn(async () => ({ code: "c", url: "u" })),
    ...overrides,
  } as never
}

describe("createFileShare", () => {
  it("creates a share carrying the files and the source conversation", async () => {
    const d = deps()
    const file = candidate("/workspace/a.txt")
    await createFileShare(
      { payload: PAYLOAD, files: [file], ttlSeconds: 3600, session: { id: "s1" } },
      undefined,
      d
    )
    expect(d.authorizeSharedSession).toHaveBeenCalledWith({ id: "s1" })
    expect(d.createShareLink).toHaveBeenCalledWith(
      {
        payload: PAYLOAD,
        ttlSeconds: 3600,
        sessionId: "s1",
        files: [{ path: "/workspace/a.txt", name: "a.txt", mime: "text/plain", open: file.open }],
      },
      undefined
    )
  })

  it("checks policy for a transcript's own attachments too, after the picked files", async () => {
    const d = deps()
    const attachment = {
      path: "/attachments/big.png",
      name: "big.png",
      mime: "image/png",
      open: jest.fn(),
    }
    await createFileShare(
      {
        payload: PAYLOAD,
        files: [candidate("/workspace/a.txt")],
        attachments: [attachment],
        ttlSeconds: 3600,
      },
      undefined,
      d
    )
    expect(d.loadPolicy).toHaveBeenCalled()
    expect(d.createShareLink.mock.calls[0][0].files.map((f: { path: string }) => f.path)).toEqual([
      "/workspace/a.txt",
      "/attachments/big.png",
    ])
    d.loadPolicy.mockClear()
    await expect(
      createFileShare(
        { payload: PAYLOAD, files: [], attachments: [attachment], ttlSeconds: 86_401 },
        undefined,
        d
      )
    ).rejects.toMatchObject({ reason: "ttl-exceeds-policy" })
  })

  it("skips every file check for a share without files", async () => {
    const d = deps()
    await createFileShare({ payload: PAYLOAD, files: [] }, undefined, d)
    expect(d.loadPolicy).not.toHaveBeenCalled()
    expect(d.authorizeSharedSession).not.toHaveBeenCalled()
    expect(d.createShareLink).toHaveBeenCalled()
  })

  it("refuses a sensitive file the person did not confirm by path", async () => {
    const d = deps()
    const file = candidate("/workspace/.env", true)
    await expect(
      createFileShare({ payload: PAYLOAD, files: [file], ttlSeconds: 60 }, undefined, d)
    ).rejects.toMatchObject({ reason: "sensitive-not-confirmed" })
    await createFileShare(
      {
        payload: PAYLOAD,
        files: [file],
        ttlSeconds: 3600,
        confirmedSensitive: new Set(["/workspace/.env"]),
      },
      undefined,
      d
    )
    expect(d.createShareLink).toHaveBeenCalledTimes(1)
  })

  it("asks the plane about a shared conversation and uses the revision it named", async () => {
    const d = deps({
      authorizeSharedSession: jest.fn(async () => ({ orgId: "org", policyRevision: 7 })),
    })
    const session = { id: "s1", collaboration: binding }
    await createFileShare(
      { payload: PAYLOAD, files: [candidate("/uploads/a")], ttlSeconds: 3600, session },
      undefined,
      d
    )
    expect(d.loadPolicy).toHaveBeenCalledWith({ minOrgRevision: 7 })
  })

  it.each([
    ["forbidden", "shared-session-forbidden"],
    ["not_found", "shared-session-unavailable"],
  ])("maps a plane refusal (%s) and creates nothing", async (reason, expected) => {
    const d = deps({
      authorizeSharedSession: jest.fn(async () => {
        throw new SharedSessionAccessError(reason as never)
      }),
    })
    const error = await createFileShare(
      {
        payload: PAYLOAD,
        files: [candidate("/uploads/a")],
        ttlSeconds: 3600,
        session: { id: "s" },
      },
      undefined,
      d
    ).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(FileShareRefusedError)
    expect((error as FileShareRefusedError).reason).toBe(expected)
    expect(d.createShareLink).not.toHaveBeenCalled()
  })

  it("refuses what the effective policy forbids", async () => {
    const d = deps()
    await expect(
      createFileShare(
        { payload: PAYLOAD, files: [candidate("/a")], ttlSeconds: 86_401 },
        undefined,
        d
      )
    ).rejects.toMatchObject({ reason: "ttl-exceeds-policy" })
    d.loadPolicy.mockResolvedValueOnce({
      policy: { ...DEFAULT_FILE_SHARING_POLICY, allowPublicSnapshots: false },
      local: DEFAULT_FILE_SHARING_POLICY,
    })
    await expect(
      createFileShare({ payload: PAYLOAD, files: [candidate("/a")], ttlSeconds: 60 }, undefined, d)
    ).rejects.toMatchObject({ reason: "public-snapshots-disabled" })
    expect(d.createShareLink).not.toHaveBeenCalled()
  })
})
