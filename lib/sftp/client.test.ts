/**
 * Runs in the `node` project deliberately: `Blob.arrayBuffer` and `atob` are
 * global there, and jsdom's `Blob` predates `arrayBuffer` entirely.
 */
import {
  closeSftpSession,
  createSftpFileTreeDeps,
  downloadSftpFile,
  joinRemotePath,
  listSftpDir,
  relativeRemotePath,
  requestSftpTransferApproval,
  SftpTransferAbortedError,
  toWorkspaceEntry,
  uploadSftpFile,
  type SftpEntry,
} from "./client"

const call = jest.fn()
const isTauri = jest.fn(() => true)
const issueHostAdminLease = jest.fn()

jest.mock("@/lib/tauri", () => ({
  transport: { call: (...args: unknown[]) => call(...args) },
  isTauri: () => isTauri(),
}))
jest.mock("@/lib/tauri/admin-lease", () => ({
  issueHostAdminLease: (...args: unknown[]) => issueHostAdminLease(...args),
}))

function entry(overrides: Partial<SftpEntry> = {}): SftpEntry {
  return {
    name: "app.log",
    path: "/var/log/app.log",
    kind: "file",
    size: 12,
    modified: 1_700_000_000,
    permissions: 0o644,
    ...overrides,
  }
}

/** Base64 for a run of bytes, matching what the host would send. */
function base64(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes))
}

beforeEach(() => {
  call.mockReset()
  isTauri.mockReturnValue(true)
  issueHostAdminLease.mockReset()
})

describe("remote paths", () => {
  /**
   * A remote path uses `/` whatever this client runs on, so the joining cannot
   * borrow the local separator. The root case matters on its own: `/` + `etc`
   * must not become `//etc`, which some servers resolve as a different path.
   */
  it("joins without doubling or dropping the separator", () => {
    expect(joinRemotePath("/srv/app", "config/db.yml")).toBe("/srv/app/config/db.yml")
    expect(joinRemotePath("/srv/app/", "config")).toBe("/srv/app/config")
    expect(joinRemotePath("/", "etc")).toBe("/etc")
    expect(joinRemotePath("/srv/app", "/config")).toBe("/srv/app/config")
    expect(joinRemotePath("/srv/app")).toBe("/srv/app")
    expect(joinRemotePath("")).toBe("/")
  })

  it("takes a path back to its base, and leaves one that is outside alone", () => {
    expect(relativeRemotePath("/srv/app", "/srv/app/config/db.yml")).toBe("config/db.yml")
    expect(relativeRemotePath("/", "/etc/hosts")).toBe("etc/hosts")
    // A symlink can land anywhere, and reporting `/etc/shadow` as a path
    // relative to `/srv/app` would say something untrue about where it is.
    expect(relativeRemotePath("/srv/app", "/etc/shadow")).toBe("/etc/shadow")
  })
})

describe("toWorkspaceEntry", () => {
  it("converts seconds to milliseconds and keeps an absent time absent", () => {
    expect(toWorkspaceEntry("/var/log", entry()).mtimeMs).toBe(1_700_000_000_000)
    expect(toWorkspaceEntry("/var/log", entry({ modified: null })).mtimeMs).toBeNull()
  })

  /**
   * A symlink is not a directory, and reporting one as `isDir` would make the
   * tree try to expand a file. `sftp_realpath` is what resolves a link, and
   * doing it per row would cost a round trip per entry.
   */
  it("reports a symlink as what the server said, not as what it points at", () => {
    expect(toWorkspaceEntry("/var/log", entry({ kind: "symlink" })).isDir).toBe(false)
    expect(toWorkspaceEntry("/var/log", entry({ kind: "dir" })).isDir).toBe(true)
  })
})

describe("browsing", () => {
  it("names the profile and an absolute path, never a root and a relative one", async () => {
    call.mockResolvedValue({ entries: [entry()] })
    await listSftpDir("production", "/var/log")
    expect(call).toHaveBeenCalledWith("sftp_list_dir", {
      profileId: "production",
      path: "/var/log",
    })
  })

  it("reports how many pooled connections were dropped", async () => {
    call.mockResolvedValue({ closed: 0 })
    await expect(closeSftpSession("production")).resolves.toBe(0)
  })
})

describe("createSftpFileTreeDeps", () => {
  it("turns the tree's base and relative path into one absolute path", async () => {
    call.mockResolvedValue({ entries: [entry({ path: "/srv/app/config", kind: "dir" })] })
    const deps = createSftpFileTreeDeps("production")
    const entries = await deps.listDir("/srv/app", "")
    expect(call).toHaveBeenCalledWith("sftp_list_dir", {
      profileId: "production",
      path: "/srv/app",
    })
    expect(entries[0]).toMatchObject({ relPath: "config", isDir: true })
  })

  it("renames within the base rather than sending a bare name", async () => {
    call.mockResolvedValue({ ok: true })
    await createSftpFileTreeDeps("production").renameEntry("/srv/app", "a.txt", "b.txt")
    expect(call).toHaveBeenCalledWith("sftp_rename_entry", {
      profileId: "production",
      from: "/srv/app/a.txt",
      to: "/srv/app/b.txt",
    })
  })
})

describe("requestSftpTransferApproval", () => {
  /**
   * The interactive approval exists so a REMOTE device asks a human at the
   * host. On the desktop the caller is that human, so asking would be asking
   * for a permission there is nobody else to grant.
   */
  it("asks for nothing on the desktop", async () => {
    isTauri.mockReturnValue(true)
    await expect(requestSftpTransferApproval()).resolves.toBeNull()
    expect(issueHostAdminLease).not.toHaveBeenCalled()
  })

  it("obtains a lease covering both opens everywhere else", async () => {
    isTauri.mockReturnValue(false)
    issueHostAdminLease.mockResolvedValue({ token: "lease-1", operations: [], expiresAt: 0 })
    await expect(requestSftpTransferApproval()).resolves.toBe("lease-1")
    expect(issueHostAdminLease).toHaveBeenCalledWith(["sftp_download_open", "sftp_upload_open"])
  })
})

describe("downloadSftpFile", () => {
  it("reads until the server says it is done, using the chunk size the host gave", async () => {
    call.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === "sftp_download_open") {
        return { transferId: "t1", size: 4, chunkBytes: 2 }
      }
      if (name === "sftp_download_read_chunk") {
        return args.offset === 0
          ? { data: base64([1, 2]), eof: false }
          : { data: base64([3, 4]), eof: true }
      }
      return {}
    })
    const blob = await downloadSftpFile("production", "/srv/app.bin")
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]))
    expect(call).toHaveBeenCalledWith("sftp_download_close", { transferId: "t1" })
  })

  /**
   * The declared size is what the file was when the handle opened. Something
   * else on that machine can append to it, and stopping at the old size would
   * silently truncate. The server's `eof` is the only authority.
   */
  it("keeps reading past the size the open reported", async () => {
    let reads = 0
    call.mockImplementation(async (name: string) => {
      if (name === "sftp_download_open") return { transferId: "t1", size: 2, chunkBytes: 2 }
      if (name === "sftp_download_read_chunk") {
        reads += 1
        return reads < 3
          ? { data: base64([reads, reads]), eof: false }
          : { data: base64([]), eof: true }
      }
      return {}
    })
    const blob = await downloadSftpFile("production", "/srv/growing.log")
    expect(blob.size).toBe(4)
  })

  it("carries the approval on the open and nowhere else", async () => {
    call.mockImplementation(async (name: string) =>
      name === "sftp_download_open"
        ? { transferId: "t1", size: 0, chunkBytes: 2 }
        : { data: "", eof: true }
    )
    await downloadSftpFile("production", "/srv/a", { adminLease: "lease-1" })
    expect(call).toHaveBeenCalledWith("sftp_download_open", {
      profileId: "production",
      path: "/srv/a",
      adminLease: "lease-1",
    })
    expect(call).toHaveBeenCalledWith("sftp_download_read_chunk", {
      transferId: "t1",
      offset: 0,
    })
  })

  it("resumes from bytes the caller already holds", async () => {
    call.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === "sftp_download_open") return { transferId: "t1", size: 3, chunkBytes: 2 }
      if (name === "sftp_download_read_chunk") {
        expect(args.offset).toBe(2)
        return { data: base64([9]), eof: true }
      }
      return {}
    })
    const blob = await downloadSftpFile("production", "/srv/a", {
      resumeFrom: new Uint8Array([7, 8]),
    })
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([7, 8, 9]))
  })

  it("closes the handle even when a chunk read fails", async () => {
    call.mockImplementation(async (name: string) => {
      if (name === "sftp_download_open") return { transferId: "t1", size: 4, chunkBytes: 2 }
      if (name === "sftp_download_read_chunk") throw new Error("Permission denied")
      return {}
    })
    await expect(downloadSftpFile("production", "/srv/a")).rejects.toThrow("Permission denied")
    expect(call).toHaveBeenCalledWith("sftp_download_close", { transferId: "t1" })
  })

  it("stops on an aborted signal", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      downloadSftpFile("production", "/srv/a", { signal: controller.signal })
    ).rejects.toBeInstanceOf(SftpTransferAbortedError)
    expect(call).not.toHaveBeenCalled()
  })
})

describe("uploadSftpFile", () => {
  it("starts at the host's write head, not at zero", async () => {
    const offsets: unknown[] = []
    call.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === "sftp_upload_open") return { transferId: "t1", chunkBytes: 2, writeHead: 2 }
      if (name === "sftp_upload_write_chunk") {
        offsets.push(args.data)
        return { writeHead: 4 }
      }
      return { path: "/srv/a", size: 4, declaredSize: 4, complete: true }
    })
    const result = await uploadSftpFile(
      "production",
      "/srv/a",
      new Blob([new Uint8Array([1, 2, 3, 4])])
    )
    // Two bytes already on the machine, so only the tail is sent.
    expect(offsets).toEqual([base64([3, 4])])
    expect(result.complete).toBe(true)
  })

  /**
   * A host that answered without advancing would put the client in a loop
   * re-sending the same bytes forever. Refusing is the honest answer, and the
   * partial file stays where it is because the alternative is a delete nobody
   * asked for.
   */
  it("refuses a write head that did not move", async () => {
    call.mockImplementation(async (name: string) => {
      if (name === "sftp_upload_open") return { transferId: "t1", chunkBytes: 2, writeHead: 0 }
      if (name === "sftp_upload_write_chunk") return { writeHead: 0 }
      return {}
    })
    await expect(
      uploadSftpFile("production", "/srv/a", new Blob([new Uint8Array([1, 2])]))
    ).rejects.toThrow(/write head/)
    expect(call).toHaveBeenCalledWith("sftp_upload_abort", { transferId: "t1" })
  })

  it("declares the size on the open, which is what the approval covers", async () => {
    call.mockImplementation(async (name: string) => {
      if (name === "sftp_upload_open") return { transferId: "t1", chunkBytes: 8, writeHead: 0 }
      if (name === "sftp_upload_write_chunk") return { writeHead: 3 }
      return { path: "/srv/a", size: 3, declaredSize: 3, complete: true }
    })
    await uploadSftpFile("production", "/srv/a", new Blob([new Uint8Array([1, 2, 3])]), {
      adminLease: "lease-1",
    })
    expect(call).toHaveBeenCalledWith("sftp_upload_open", {
      profileId: "production",
      path: "/srv/a",
      size: 3,
      adminLease: "lease-1",
    })
  })

  it("reports a commit that landed short rather than calling it done", async () => {
    call.mockImplementation(async (name: string) => {
      if (name === "sftp_upload_open") return { transferId: "t1", chunkBytes: 8, writeHead: 0 }
      if (name === "sftp_upload_write_chunk") return { writeHead: 2 }
      return { path: "/srv/a", size: 2, declaredSize: 3, complete: false }
    })
    const result = await uploadSftpFile("production", "/srv/a", new Blob([new Uint8Array([1, 2])]))
    expect(result).toMatchObject({ size: 2, declaredSize: 3, complete: false })
  })
})
