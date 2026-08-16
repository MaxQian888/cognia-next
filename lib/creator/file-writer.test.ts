import { resolveAuthoringPath, writeCreatorFile } from "./file-writer"
import type { AuthoringRoot } from "@/types/creator"
import type { CreatorAdvanceState } from "./steps"

const root: AuthoringRoot = {
  path: "/work/authoring",
  label: "authoring",
  origin: "selected",
  grantedAt: 0,
}

/** A run that has cleared the permission gate. */
const APPROVED: CreatorAdvanceState = {
  completed: ["approve-permissions"],
  approvals: ["permission-widening"],
}

function fakeOps() {
  const writes: Array<{ path: string; content: string; roots: string[] }> = []
  return {
    writes,
    ops: {
      writeText: async (path: string, content: string, roots: string[]) => {
        writes.push({ path, content, roots })
      },
      mkdir: async () => {},
    },
  }
}

describe("resolveAuthoringPath", () => {
  it("joins a relative path onto the root", () => {
    expect(resolveAuthoringPath(root, "src/index.ts")).toBe("/work/authoring/src/index.ts")
  })

  it("strips a leading ./", () => {
    expect(resolveAuthoringPath(root, "./src/a.ts")).toBe("/work/authoring/src/a.ts")
  })

  it("tolerates a root with a trailing slash", () => {
    expect(resolveAuthoringPath({ ...root, path: "/work/authoring/" }, "a.ts")).toBe(
      "/work/authoring/a.ts"
    )
  })

  // Silent rebasing would hide a generator that emitted an absolute path.
  it.each(["/etc/passwd", "C:/Windows/system32", "\\\\server\\share\\x"])(
    "refuses the absolute path %p rather than rebasing it",
    (input) => {
      expect(resolveAuthoringPath(root, input)).toBeNull()
    }
  )

  it("refuses an empty path", () => {
    expect(resolveAuthoringPath(root, "   ")).toBeNull()
  })
})

describe("writeCreatorFile", () => {
  it("writes through the confined backend and records the write", async () => {
    const { ops, writes } = fakeOps()
    const log = { fileWritten: jest.fn(async () => undefined) }

    const result = await writeCreatorFile(
      { relativePath: "src/index.ts", contents: "export {}" },
      { root, state: APPROVED, ops, log: log as never }
    )

    expect(result).toEqual({ ok: true, relativePath: "src/index.ts", bytes: 9 })
    expect(writes).toEqual([
      { path: "/work/authoring/src/index.ts", content: "export {}", roots: ["/work/authoring"] },
    ])
    expect(log.fileWritten).toHaveBeenCalledWith("src/index.ts", 9)
  })

  // Gate 1. Checked before the path is resolved, so a caller that skipped the
  // gate learns nothing about the filesystem from the refusal.
  it("refuses every write until the permission diff is approved", async () => {
    const { ops, writes } = fakeOps()
    const result = await writeCreatorFile(
      { relativePath: "src/index.ts", contents: "x" },
      { root, state: { completed: [], approvals: [] }, ops }
    )
    expect(result).toMatchObject({ ok: false, reason: "writes-not-approved" })
    expect(writes).toEqual([])
  })

  it("refuses when the approval was granted but the gate step never completed", async () => {
    const { ops } = fakeOps()
    const result = await writeCreatorFile(
      { relativePath: "a.ts", contents: "x" },
      { root, state: { completed: [], approvals: ["permission-widening"] }, ops }
    )
    expect(result).toMatchObject({ ok: false, reason: "writes-not-approved" })
  })

  it("refuses when the approval was withdrawn after the gate completed", async () => {
    const { ops } = fakeOps()
    const result = await writeCreatorFile(
      { relativePath: "a.ts", contents: "x" },
      { root, state: { completed: ["approve-permissions"], approvals: [] }, ops }
    )
    expect(result).toMatchObject({ ok: false, reason: "writes-not-approved" })
  })

  // Gate 2.
  it("refuses a traversal that escapes the root", async () => {
    const { ops, writes } = fakeOps()
    const result = await writeCreatorFile(
      { relativePath: "../secrets/key.txt", contents: "x" },
      { root, state: APPROVED, ops }
    )
    expect(result).toMatchObject({ ok: false, reason: "denied" })
    expect(writes).toEqual([])
  })

  it.each([".env", "nested/.git/config", "keys/server.pem"])(
    "refuses %p even though it is inside the root",
    async (relativePath) => {
      const { ops, writes } = fakeOps()
      const result = await writeCreatorFile(
        { relativePath, contents: "x" },
        { root, state: APPROVED, ops }
      )
      expect(result).toMatchObject({ ok: false, reason: "denied" })
      expect(writes).toEqual([])
    }
  )

  it("refuses an absolute path", async () => {
    const { ops, writes } = fakeOps()
    const result = await writeCreatorFile(
      { relativePath: "/etc/passwd", contents: "x" },
      { root, state: APPROVED, ops }
    )
    expect(result).toMatchObject({ ok: false, reason: "denied" })
    expect(writes).toEqual([])
  })

  it("refuses a file over the size ceiling", async () => {
    const { ops, writes } = fakeOps()
    const result = await writeCreatorFile(
      { relativePath: "big.bin", contents: "x".repeat(1024 * 1024 + 1) },
      { root, state: APPROVED, ops }
    )
    expect(result).toMatchObject({ ok: false, reason: "denied" })
    expect(writes).toEqual([])
  })

  // Gate 3: the authoritative check lives in Rust and can reject a symlink
  // escape the lexical pass cannot see.
  it("reports a refusal from the confined host backend", async () => {
    const ops = {
      writeText: async () => {
        throw new Error("path escapes the allowed roots")
      },
      mkdir: async () => {},
    }
    const result = await writeCreatorFile(
      { relativePath: "a.ts", contents: "x" },
      { root, state: APPROVED, ops }
    )
    expect(result).toEqual({
      ok: false,
      reason: "host-error",
      detail: "path escapes the allowed roots",
    })
  })

  it("does not log a write that the host rejected", async () => {
    const log = { fileWritten: jest.fn(async () => undefined) }
    const ops = {
      writeText: async () => {
        throw new Error("nope")
      },
      mkdir: async () => {},
    }
    await writeCreatorFile(
      { relativePath: "a.ts", contents: "x" },
      { root, state: APPROVED, ops, log: log as never }
    )
    expect(log.fileWritten).not.toHaveBeenCalled()
  })

  it("counts UTF-8 bytes, not characters", async () => {
    const { ops } = fakeOps()
    const result = await writeCreatorFile(
      { relativePath: "a.ts", contents: "中文" },
      { root, state: APPROVED, ops }
    )
    expect(result).toMatchObject({ ok: true, bytes: 6 })
  })

  it("works without a log", async () => {
    const { ops } = fakeOps()
    await expect(
      writeCreatorFile({ relativePath: "a.ts", contents: "x" }, { root, state: APPROVED, ops })
    ).resolves.toMatchObject({ ok: true })
  })
})
