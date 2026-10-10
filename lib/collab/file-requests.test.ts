/** @jest-environment node */
import type { CollabFileRequest } from "./client"
import {
  deleteMemberPath,
  isValidMemberName,
  joinMemberPath,
  listMemberFolder,
  makeMemberFolder,
  MAX_MEMBER_TRANSFER_BYTES,
  MemberFileError,
  parentMemberPath,
  readMemberFile,
  renameMemberPath,
  runMemberFileRequest,
  writeMemberFile,
  type SharedFilesTarget,
} from "./file-requests"

function request(overrides: Partial<CollabFileRequest> = {}): CollabFileRequest {
  return {
    id: "frq_1",
    grantId: "fg_1",
    op: "list",
    path: "/",
    status: "pending",
    createdAt: 0,
    expiresAt: 120_000,
    ...overrides,
  }
}

function target(polls: Partial<CollabFileRequest>[], created: Partial<CollabFileRequest> = {}) {
  const queue = [...polls]
  const client = {
    createFileRequest: jest.fn(async () => request(created)),
    getFileRequest: jest.fn(async () => request(queue.shift() ?? {})),
    uploadFileRequestBytes: jest.fn(async () => undefined),
    downloadFileRequestResult: jest.fn(async () => new Blob(["alpha"])),
  }
  const t: SharedFilesTarget & { client: typeof client } = {
    client,
    orgId: "org_1",
    sessionId: "ses_1",
  }
  return t
}

function clock() {
  let now = 0
  const sleeps: number[] = []
  return {
    sleeps,
    deps: {
      now: () => now,
      sleep: async (ms: number) => {
        sleeps.push(ms)
        now += ms
      },
    },
  }
}

describe("runMemberFileRequest", () => {
  it("waits for the host's answer, backing off between polls", async () => {
    const t = target([{ status: "claimed" }, { status: "claimed" }, { status: "done" }])
    const { deps, sleeps } = clock()
    const done = await runMemberFileRequest(
      t,
      { grantId: "fg_1", op: "list", path: "/" },
      undefined,
      {},
      deps
    )
    expect(done.status).toBe("done")
    expect(sleeps).toEqual([300, 600, 1200])
    expect(t.client.getFileRequest).toHaveBeenCalledWith("org_1", "ses_1", "frq_1")
  })

  it("names a refusal, an unanswered request and a lost wait", async () => {
    const { deps } = clock()
    await expect(
      runMemberFileRequest(
        target([{ status: "failed", error: "sensitive" }]),
        {
          grantId: "fg_1",
          op: "read",
          path: "/workspace/.env",
        },
        undefined,
        {},
        deps
      )
    ).rejects.toEqual(new MemberFileError("sensitive"))
    await expect(
      runMemberFileRequest(
        target([{ status: "expired" }]),
        { grantId: "fg_1", op: "list", path: "/" },
        undefined,
        {},
        clock().deps
      )
    ).rejects.toMatchObject({ code: "host_unavailable" })
    const forever = target(
      Array.from({ length: 200 }, () => ({ status: "pending" as const })),
      {
        expiresAt: 1_000,
      }
    )
    await expect(
      runMemberFileRequest(
        forever,
        { grantId: "fg_1", op: "list", path: "/" },
        undefined,
        {},
        clock().deps
      )
    ).rejects.toMatchObject({ code: "timeout" })
    const controller = new AbortController()
    controller.abort()
    await expect(
      runMemberFileRequest(
        target([]),
        { grantId: "fg_1", op: "list", path: "/" },
        undefined,
        {
          signal: controller.signal,
        },
        clock().deps
      )
    ).rejects.toMatchObject({ code: "cancelled" })
  })
})

describe("member operations", () => {
  it("lists a folder, keeping only well-formed entries", async () => {
    const t = target([
      {
        status: "done",
        result: {
          entries: [{ name: "a.txt", isDir: false, size: 5, modifiedAt: 1 }, { name: 3 }],
          truncated: true,
        },
      },
    ])
    await expect(
      listMemberFolder(t, "fg_1", "/workspace", undefined, clock().deps)
    ).resolves.toEqual({
      entries: [{ name: "a.txt", isDir: false, size: 5, modifiedAt: 1 }],
      truncated: true,
    })
    expect(t.client.createFileRequest).toHaveBeenCalledWith("org_1", "ses_1", {
      grantId: "fg_1",
      op: "list",
      path: "/workspace",
    })
  })

  it("reads a file's bytes from the requester's own result", async () => {
    const t = target([{ status: "done" }])
    const blob = await readMemberFile(t, "fg_1", "/workspace/a.txt", undefined, clock().deps)
    expect(await blob.text()).toBe("alpha")
    expect(t.client.downloadFileRequestResult).toHaveBeenCalledWith("org_1", "ses_1", "frq_1")
  })

  it("declares a write's length and hash, then uploads exactly those bytes", async () => {
    const t = target([{ status: "done" }], { status: "awaiting_upload" })
    const bytes = new TextEncoder().encode("abc")
    await writeMemberFile(t, "fg_1", "/workspace/a.txt", bytes, undefined, clock().deps)
    expect(t.client.createFileRequest).toHaveBeenCalledWith("org_1", "ses_1", {
      grantId: "fg_1",
      op: "write",
      path: "/workspace/a.txt",
      upload: {
        byteLength: 3,
        sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      },
    })
    expect(t.client.uploadFileRequestBytes).toHaveBeenCalledWith("org_1", "ses_1", "frq_1", bytes)
    await expect(
      writeMemberFile(t, "fg_1", "/x", new Uint8Array(MAX_MEMBER_TRANSFER_BYTES + 1))
    ).rejects.toMatchObject({ code: "too_large" })
  })

  it("makes folders, deletes and renames", async () => {
    const t = target([{ status: "done" }, { status: "done" }, { status: "done" }])
    const { deps } = clock()
    await makeMemberFolder(t, "fg_1", "/workspace/new", deps)
    await deleteMemberPath(t, "fg_1", "/workspace/old.txt", deps)
    await renameMemberPath(t, "fg_1", "/workspace/a.txt", "/workspace/b.txt", deps)
    expect(t.client.createFileRequest.mock.calls.map((call) => (call as unknown[])[2])).toEqual([
      { grantId: "fg_1", op: "mkdir", path: "/workspace/new" },
      { grantId: "fg_1", op: "delete", path: "/workspace/old.txt" },
      { grantId: "fg_1", op: "rename", path: "/workspace/a.txt", destPath: "/workspace/b.txt" },
    ])
  })
})

describe("paths", () => {
  it("joins, splits and checks names in the FileSpace grammar", () => {
    expect(joinMemberPath("/", "workspace")).toBe("/workspace")
    expect(joinMemberPath("/workspace", "a.txt")).toBe("/workspace/a.txt")
    expect(parentMemberPath("/workspace/a.txt")).toBe("/workspace")
    expect(parentMemberPath("/workspace")).toBe("/")
    expect(isValidMemberName("notes.md")).toBe(true)
    for (const bad of ["", ".", "..", "a/b", "a\\b", "a\u0000b", "x".repeat(256)]) {
      expect(isValidMemberName(bad)).toBe(false)
    }
  })
})
