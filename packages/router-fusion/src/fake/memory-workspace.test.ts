import { sha256Hex } from "../util/sha256"
import { buildDelegatePatch, type DelegatePatchEdit } from "../workflows/delegate-ports"
import { MemoryWorkspace } from "./memory-workspace"

const FILES = { "src/a.ts": "a\n", "src/b.ts": "b\n", "docs/readme.md": "hi\n", "vendor/link": "x" }

function patchOf(base: string, edits: Array<[string, DelegatePatchEdit]>) {
  return buildDelegatePatch(base, new Map(edits))
}

describe("MemoryWorkspace", () => {
  it("reads and lists at a revision, refusing escapes and marked symlinks", async () => {
    const ws = new MemoryWorkspace(FILES, {
      symlinkEscapes: ["vendor/link"],
      sensitiveContent: ["docs/readme.md"],
    })
    expect(await ws.readFile({ path: "./src/a.ts", revision: "rev-0", maxBytes: 100 })).toEqual({
      ok: true,
      content: "a\n",
      contentSha256: sha256Hex("a\n"),
      truncated: false,
    })
    expect(await ws.readFile({ path: "src/a.ts", revision: "rev-0", maxBytes: 1 })).toMatchObject({
      ok: true,
      content: "a",
      truncated: true,
    })
    expect(
      await ws.readFile({ path: "../etc/passwd", revision: "rev-0", maxBytes: 9 })
    ).toMatchObject({
      ok: false,
      code: "PATH_TRAVERSAL",
    })
    expect(
      await ws.readFile({ path: "vendor/link", revision: "rev-0", maxBytes: 9 })
    ).toMatchObject({
      ok: false,
      code: "PATH_ESCAPE",
    })
    expect(
      await ws.readFile({ path: "docs/readme.md", revision: "rev-0", maxBytes: 9 })
    ).toMatchObject({
      ok: false,
      code: "CONTENT_SENSITIVE",
    })
    expect(await ws.readFile({ path: "src/zz.ts", revision: "rev-0", maxBytes: 9 })).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    })
    expect(await ws.readFile({ path: "src/a.ts", revision: "rev-9", maxBytes: 9 })).toMatchObject({
      ok: false,
      code: "REVISION_UNKNOWN",
    })
    expect(await ws.listFiles({ prefix: "", revision: "rev-0", limit: 2 })).toEqual({
      ok: true,
      files: [
        { path: "docs/readme.md", sizeBytes: 3 },
        { path: "src/a.ts", sizeBytes: 2 },
      ],
      truncated: true,
    })
    expect(await ws.listFiles({ prefix: "src/", revision: "rev-0", limit: 10 })).toMatchObject({
      ok: true,
      files: [{ path: "src/a.ts" }, { path: "src/b.ts" }],
      truncated: false,
    })
    expect(await ws.listFiles({ prefix: "vendor", revision: "rev-0", limit: 10 })).toMatchObject({
      ok: true,
      files: [],
    })
    expect(await ws.listFiles({ prefix: "/", revision: "rev-0", limit: 10 })).toMatchObject({
      ok: false,
      code: "PATH_ABSOLUTE",
    })
    expect(await ws.listFiles({ prefix: "", revision: "nope", limit: 10 })).toMatchObject({
      ok: false,
      code: "REVISION_UNKNOWN",
    })
  })

  it("stages a patch in its own snapshot, the same patch to the same revision", async () => {
    const ws = new MemoryWorkspace(FILES)
    const patch = patchOf("rev-0", [
      ["src/a.ts", { action: "write", content: "A\n" }],
      ["src/b.ts", { action: "delete" }],
    ])
    const staged = await ws.stagePatch({ runId: "r", logicalStepId: "s", patch })
    if (!staged.ok) throw new Error("expected staged")
    expect(ws.current).toBe("rev-0")
    expect(ws.filesAt(staged.revision)).toEqual({
      "src/a.ts": "A\n",
      "docs/readme.md": "hi\n",
      "vendor/link": "x",
    })
    expect(ws.filesAt("rev-0")?.["src/a.ts"]).toBe("a\n")
    expect(await ws.stagePatch({ runId: "r", logicalStepId: "s2", patch })).toEqual(staged)
    expect(
      await ws.stagePatch({ runId: "r", logicalStepId: "s", patch: patchOf("rev-x", []) })
    ).toMatchObject({
      ok: false,
      code: "REVISION_UNKNOWN",
    })
    const tampered = { ...patch, files: [{ ...patch.files[0], content: "evil\n" }] }
    expect(await ws.stagePatch({ runId: "r", logicalStepId: "s", patch: tampered })).toMatchObject({
      ok: false,
      code: "PATCH_REFUSED",
      path: "src/a.ts",
    })
  })

  it("applies with a compare-and-swap and never overwrites a workspace that moved", async () => {
    const ws = new MemoryWorkspace(FILES, { symlinkEscapes: ["vendor/link"] })
    const patch = patchOf("rev-0", [["src/a.ts", { action: "write", content: "A\n" }]])
    expect(await ws.applyPatchCAS({ patch, baseRevision: "rev-0", approvalId: "ap-1" })).toEqual({
      ok: true,
      revision: "rev-applied-1",
    })
    expect(ws.current).toBe("rev-applied-1")
    expect(ws.applied[0]).toMatchObject({ baseRevision: "rev-0", approvalId: "ap-1" })

    // The same patch again is against a base that is gone.
    expect(
      await ws.applyPatchCAS({ patch, baseRevision: "rev-0", approvalId: "ap-1" })
    ).toMatchObject({
      ok: false,
      code: "PATCH_CONFLICT",
      currentRevision: "rev-applied-1",
    })
    ws.externalEdit("src/a.ts", "theirs\n")
    const later = patchOf(ws.current, [["vendor/link", { action: "write", content: "y" }]])
    expect(
      await ws.applyPatchCAS({ patch: later, baseRevision: ws.current, approvalId: "ap-2" })
    ).toMatchObject({
      ok: false,
      code: "PATCH_REFUSED",
      path: "vendor/link",
    })
    expect(ws.filesAt(ws.current)?.["src/a.ts"]).toBe("theirs\n")
    expect(ws.conflicts).toEqual([{ baseRevision: "rev-0", currentRevision: "rev-applied-1" }])
    // A patch whose own base disagrees with the CAS base is a conflict too.
    expect(
      await ws.applyPatchCAS({ patch, baseRevision: ws.current, approvalId: "ap-3" })
    ).toMatchObject({ ok: false, code: "PATCH_CONFLICT" })
  })
})
