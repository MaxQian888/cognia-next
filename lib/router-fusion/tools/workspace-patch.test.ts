import { buildDelegatePatch, sha256Hex, type DelegatePatch } from "@cognia/router-fusion"

import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
  createDelegateWorkspacePort,
  defaultDelegateWorkspaceHost,
  gitWorkspaceRevision,
  stagedRevisionId,
  WORKSPACE_REVISION_COMMANDS,
  type DelegateWorkspaceHost,
} from "./workspace-patch"

const WORK = "/work/repo"

interface FakeHostOptions {
  /** Paths that are symbolic links, in any tree. */
  symlinks?: string[]
  /** null makes the root a non-git workspace. */
  head?: string | null
  dirty?: string[]
  /** Fail `openStaging`, as a busy host does. */
  stagingError?: string
}

/**
 * A filesystem in a map, with the same shape as the host bridges: one tree per
 * root, mtimes that move when a file is written, symlinks the stat reports,
 * and a git head plus a dirty list the revision is computed from.
 */
function fakeHost(files: Record<string, string>, options: FakeHostOptions = {}) {
  const trees = new Map<string, Map<string, string>>([[WORK, new Map(Object.entries(files))]])
  const mtimes = new Map<string, number>()
  let clock = 1_000
  const symlinks = new Set(options.symlinks ?? [])
  const openings: Array<{ purpose: string; baseRevision: string; root: string }> = []
  const disposals: string[] = []
  const applies: Array<{ taskRunId: string | null; approvalId: string }> = []
  let scriptedApply: {
    status: "applied" | "conflict" | "refused"
    currentRevision?: string
    refusal?: string
  } | null = null
  let head: string | null = options.head === undefined ? "a".repeat(40) : options.head
  let dirty = [...(options.dirty ?? [])]
  let opened = 0

  const tree = (root: string): Map<string, string> => {
    const found = trees.get(root)
    if (!found) throw new Error(`no such root ${root}`)
    return found
  }
  const touch = (root: string, path: string) => mtimes.set(`${root}|${path}`, ++clock)

  const host: DelegateWorkspaceHost = {
    async readFile(root, relPath, maxBytes) {
      if (symlinks.has(relPath)) throw new Error("path escapes workspace")
      const content = tree(root).get(relPath)
      if (content === undefined) throw new Error(`read ${relPath}: No such file or directory`)
      return content.length > maxBytes ? `${content.slice(0, maxBytes)}\n... (truncated)` : content
    },
    async writeFile(root, relPath, content) {
      tree(root).set(relPath, content)
      touch(root, relPath)
    },
    async deleteEntry(root, relPath) {
      if (!tree(root).delete(relPath)) throw new Error(`no such entry ${relPath}`)
    },
    async stat(root, relPath) {
      const content = trees.get(root)?.get(relPath)
      return {
        exists: content !== undefined,
        isDir: false,
        size: content === undefined ? 0 : content.length,
        mtimeMs: mtimes.get(`${root}|${relPath}`) ?? 1,
        isSymlink: symlinks.has(relPath),
      }
    },
    async list(root, prefix, limit) {
      const all = [...tree(root).entries()]
        .filter(([path]) => prefix === "" || path === prefix || path.startsWith(`${prefix}/`))
        .sort(([a], [b]) => (a < b ? -1 : 1))
      return {
        files: all.slice(0, limit).map(([path, content]) => ({
          path,
          sizeBytes: content.length,
          mtimeMs: mtimes.get(`${root}|${path}`) ?? 1,
        })),
        truncated: all.length > limit,
      }
    },
    async revision(root) {
      // The git fallback, so the revision rules are exercised end to end.
      return gitWorkspaceRevision(root, host)
    },
    async headRevision() {
      return head
    },
    async dirtyEntries() {
      return dirty
    },
    async openStaging(request) {
      if (options.stagingError) throw new Error(options.stagingError)
      const root = `/staged/${request.purpose}-${++opened}`
      // A worktree is a copy of the checkout AS IT IS NOW.
      trees.set(root, new Map(tree(WORK)))
      openings.push({ purpose: request.purpose, baseRevision: request.baseRevision, root })
      return { root, taskRunId: `task-run-${opened}` }
    },
    async disposeStaging({ root }) {
      disposals.push(root)
      trees.delete(root)
    },
    async applyPatch({ workspaceRoot, taskRunId, patch, approvalId }) {
      applies.push({ taskRunId, approvalId })
      // The host's own compare-and-swap may still lose a race the port could
      // not see; a scripted outcome stands in for that.
      if (scriptedApply) return scriptedApply
      for (const file of patch.files) {
        if (file.action === "delete") tree(workspaceRoot).delete(file.path)
        else tree(workspaceRoot).set(file.path, file.content ?? "")
      }
      return { status: "applied" as const }
    },
  }

  return {
    host,
    trees,
    openings,
    disposals,
    applies,
    filesAt: (root: string) => Object.fromEntries(tree(root)),
    workspaceFiles: () => Object.fromEntries(tree(WORK)),
    /** Someone edits the user's checkout while the run is in flight. */
    externalEdit(path: string, content: string) {
      tree(WORK).set(path, content)
      touch(WORK, path)
      if (!dirty.includes(`M:0:${path}`)) dirty = [...dirty, `M:0:${path}`]
    },
    commit(next: string) {
      head = next
      dirty = []
    },
    scriptApply(outcome: {
      status: "applied" | "conflict" | "refused"
      currentRevision?: string
      refusal?: string
    }) {
      scriptedApply = outcome
    },
  }
}

const FILES = {
  "src/users/list.ts": "export const list = []\n",
  "tests/users/list.test.ts": "test('race', () => {})\n",
  ".env": "TOKEN=sk-live-abcdefghijklmnop\n",
  "README.md": "# fixture\n",
}

function port(world: ReturnType<typeof fakeHost>, runId = "run-1") {
  return createDelegateWorkspacePort({ runId, workspaceRoot: WORK, host: world.host })
}

const signal = new AbortController().signal

function patchOf(base: string, edits: Record<string, string | null>): DelegatePatch {
  return buildDelegatePatch(
    base,
    new Map(
      Object.entries(edits).map(([path, content]) => [
        path,
        content === null
          ? ({ action: "delete" } as const)
          : ({ action: "write", content } as const),
      ])
    )
  )
}

async function stage(
  workspace: ReturnType<typeof port>,
  edits: Record<string, string | null>,
  base?: string
): Promise<{ patch: DelegatePatch; revision: string }> {
  const at = base ?? (await workspace.currentRevision())
  const patch = patchOf(at, edits)
  const staged = await workspace.stagePatch({
    runId: "run-1",
    logicalStepId: "delegate:stage:1",
    patch,
    signal,
  })
  if (!staged.ok) throw new Error(`staging refused: ${staged.code} ${staged.message}`)
  return { patch, revision: staged.revision }
}

describe("the host commands this port calls", () => {
  const repoRoot = join(__dirname, "../../..")

  it("names the three commands the desktop shell actually registers", () => {
    const definitions = readFileSync(join(repoRoot, "src-tauri/src/task_workspace.rs"), "utf8")
    const registrations = readFileSync(join(repoRoot, "src-tauri/src/lib.rs"), "utf8")
    for (const command of Object.values(WORKSPACE_REVISION_COMMANDS)) {
      // Defined as a command, and reachable through the invoke handler: a
      // crate function nobody registered is not a command a renderer can call.
      expect(definitions).toContain(`pub async fn ${command}(`)
      expect(registrations).toContain(`task_workspace::${command},`)
    }
    expect(WORKSPACE_REVISION_COMMANDS).toEqual({
      get: "task_workspace_revision_get",
      apply: "task_workspace_revision_apply",
      read: "task_workspace_revision_read",
    })
  })

  it("says what is missing on a host that has no local workspace at all", async () => {
    // No Tauri transport and no git bridge (web, a companion device): the run
    // cannot start, and the refusal names the reason instead of surfacing an
    // "unknown command" from three layers down.
    await expect(defaultDelegateWorkspaceHost().revision("/nowhere")).rejects.toThrow(
      /cannot read a local workspace revision/
    )
  })
})

describe("gitWorkspaceRevision", () => {
  it("names a clean checkout by its head, and a dirty one by head plus what changed", async () => {
    const world = fakeHost(FILES, { head: "b".repeat(40) })
    const clean = await world.host.revision(WORK)
    expect(clean).toBe(`git:${"b".repeat(40)}`)

    world.externalEdit("src/users/list.ts", "export const list = [1]\n")
    const dirty = await world.host.revision(WORK)
    expect(dirty).toMatch(/^git:b{40}\+[0-9a-f]{32}$/)
    expect(dirty).not.toBe(clean)

    // A second edit of the SAME already-dirty file is a third revision: the
    // git status letter does not change between them.
    world.externalEdit("src/users/list.ts", "export const list = [1, 2]\n")
    expect(await world.host.revision(WORK)).not.toBe(dirty)
  })

  it("digests the tree when the workspace is not a git checkout", async () => {
    const world = fakeHost(FILES, { head: null })
    const first = await world.host.revision(WORK)
    expect(first).toMatch(/^tree:[0-9a-f]{32}$/)
    world.externalEdit("README.md", "# changed\n")
    expect(await world.host.revision(WORK)).not.toBe(first)
  })
})

describe("createDelegateWorkspacePort reads", () => {
  it("snapshots the base once and reads the snapshot, not the checkout", async () => {
    const world = fakeHost(FILES)
    const workspace = port(world)
    const revision = await workspace.currentRevision()
    await expect(
      workspace.readFile({ path: "src\\users\\list.ts", revision, maxBytes: 64_000 })
    ).resolves.toEqual({
      ok: true,
      content: "export const list = []\n",
      contentSha256: sha256Hex("export const list = []\n"),
      truncated: false,
    })
    // Two worktrees, provisioned once: the pristine base and the staging tree.
    expect(world.openings.map((entry) => entry.purpose)).toEqual(["base", "staging"])
    await workspace.readFile({ path: "README.md", revision, maxBytes: 100 })
    expect(world.openings).toHaveLength(2)
    expect(await workspace.rootForRevision(revision)).toBe(world.openings[0].root)
  })

  it("keeps reading the run's revision while the person keeps editing", async () => {
    const world = fakeHost(FILES)
    const workspace = port(world)
    const base = await workspace.currentRevision()
    await workspace.readFile({ path: "src/users/list.ts", revision: base, maxBytes: 100 })

    // The person edits the same file, and commits something else, mid-run.
    world.externalEdit("src/users/list.ts", "someone else's edit\n")
    world.externalEdit("README.md", "# theirs\n")
    expect(await world.host.revision(WORK)).not.toBe(base)

    // The run still reads what it was given, from its own snapshot.
    await expect(
      workspace.readFile({ path: "src/users/list.ts", revision: base, maxBytes: 100 })
    ).resolves.toMatchObject({ ok: true, content: "export const list = []\n" })
    const listed = await workspace.listFiles({ prefix: "", revision: base, limit: 50 })
    expect(listed.ok && listed.files.map((file) => file.path)).toEqual([
      "README.md",
      "src/users/list.ts",
      "tests/users/list.test.ts",
    ])
    // And staging still works, on the snapshot's content.
    const staged = await stage(workspace, { "src/users/list.ts": "guarded\n" }, base)
    const stagedRoot = await workspace.rootForRevision(staged.revision)
    expect(world.filesAt(stagedRoot as string)).toMatchObject({
      "src/users/list.ts": "guarded\n",
      "README.md": "# fixture\n",
    })
  })

  it("refuses to snapshot a checkout that moved before the run could", async () => {
    const world = fakeHost(FILES)
    const workspace = port(world)
    const base = await workspace.currentRevision()
    world.externalEdit("src/users/list.ts", "someone else's edit\n")
    const read = await workspace.readFile({
      path: "src/users/list.ts",
      revision: base,
      maxBytes: 100,
    })
    expect(read).toMatchObject({ ok: false, code: "REVISION_UNKNOWN" })
    expect(world.openings).toEqual([])
  })

  it("[ACC:DEL-05] refuses an escape, a credential path and a symlink before any read", async () => {
    const world = fakeHost({ ...FILES, "docs/link": "" }, { symlinks: ["docs/link"] })
    const workspace = port(world)
    const revision = await workspace.currentRevision()
    const read = (path: string) => workspace.readFile({ path, revision, maxBytes: 100 })

    await expect(read("../../etc/passwd")).resolves.toMatchObject({ code: "PATH_TRAVERSAL" })
    await expect(read("/etc/passwd")).resolves.toMatchObject({ code: "PATH_ABSOLUTE" })
    await expect(read(".env")).resolves.toMatchObject({ code: "PATH_SENSITIVE" })
    await expect(read("var/run/docker.sock")).resolves.toMatchObject({ code: "PATH_SENSITIVE" })
    const link = await read("docs/link")
    expect(link).toMatchObject({ ok: false, code: "PATH_ESCAPE" })
    expect(JSON.stringify(link)).toContain("PATH_SYMLINK")
  })

  it("refuses a file whose content fails the PII gate, without returning it", async () => {
    const world = fakeHost({
      "docs/contacts.md":
        "owner: jane.doe@example.com\nkey: sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
    })
    const workspace = port(world)
    const revision = await workspace.currentRevision()
    const read = await workspace.readFile({ path: "docs/contacts.md", revision, maxBytes: 64_000 })
    expect(read).toEqual({
      ok: false,
      code: "CONTENT_SENSITIVE",
      message: "refused: CONTENT_SENSITIVE",
    })
    expect(JSON.stringify(read)).not.toContain("jane.doe")
  })

  it("refuses a read at a revision this run never produced", async () => {
    const world = fakeHost(FILES)
    const workspace = port(world)
    await workspace.currentRevision()
    await expect(
      workspace.readFile({ path: "src/users/list.ts", revision: "staged:nope", maxBytes: 100 })
    ).resolves.toMatchObject({ ok: false, code: "REVISION_UNKNOWN" })
  })

  it("lists a prefix, hides credential paths from the model and reports the cap", async () => {
    const world = fakeHost(FILES)
    const workspace = port(world)
    const revision = await workspace.currentRevision()
    const all = await workspace.listFiles({ prefix: "", revision, limit: 50 })
    expect(all.ok && all.files.map((file) => file.path)).toEqual([
      "README.md",
      "src/users/list.ts",
      "tests/users/list.test.ts",
    ])
    const scoped = await workspace.listFiles({ prefix: "src", revision, limit: 50 })
    expect(scoped.ok && scoped.files.map((file) => file.path)).toEqual(["src/users/list.ts"])
    const capped = await workspace.listFiles({ prefix: "", revision, limit: 1 })
    expect(capped.ok && capped.truncated).toBe(true)
    await expect(
      workspace.listFiles({ prefix: "../..", revision, limit: 5 })
    ).resolves.toMatchObject({ ok: false, code: "PATH_TRAVERSAL" })
  })
})

describe("createDelegateWorkspacePort staging", () => {
  it("stages into the run's own worktree, never the user's checkout", async () => {
    const world = fakeHost(FILES)
    const workspace = port(world)
    const before = world.workspaceFiles()
    const { patch, revision } = await stage(workspace, {
      "src/users/list.ts": "export const list = guarded([])\n",
    })

    expect(revision).toBe(stagedRevisionId(patch.base_revision, sha256Hex(JSON.stringify(patch))))
    expect(world.workspaceFiles()).toEqual(before)
    const stagedRoot = (await workspace.rootForRevision(revision)) as string
    expect(stagedRoot).toBe(world.openings[1].root)
    expect(world.filesAt(stagedRoot)["src/users/list.ts"]).toBe("export const list = guarded([])\n")
    await expect(
      workspace.readFile({ path: "src/users/list.ts", revision, maxBytes: 100 })
    ).resolves.toMatchObject({ ok: true, content: "export const list = guarded([])\n" })
    expect(workspace.staged.map((entry) => entry.revision)).toEqual([revision])
  })

  it("moves the staging tree between revisions, returning dropped files to base", async () => {
    const world = fakeHost(FILES)
    const workspace = port(world)
    const base = await workspace.currentRevision()
    const first = await stage(
      workspace,
      { "src/users/list.ts": "guarded\n", "tests/users/list.test.ts": "test('new', () => {})\n" },
      base
    )
    // A repair that keeps the fix and abandons the test edit.
    const second = await stage(workspace, { "src/users/list.ts": "guarded twice\n" }, base)
    const root = (await workspace.rootForRevision(second.revision)) as string
    expect(world.filesAt(root)).toMatchObject({
      "src/users/list.ts": "guarded twice\n",
      // Back to the base content, not the abandoned attempt's.
      "tests/users/list.test.ts": "test('race', () => {})\n",
    })
    // And an earlier revision can still be read: the tree moves back to it.
    await expect(
      workspace.readFile({
        path: "tests/users/list.test.ts",
        revision: first.revision,
        maxBytes: 100,
      })
    ).resolves.toMatchObject({ ok: true, content: "test('new', () => {})\n" })
    // Still two worktrees for the whole run.
    expect(world.openings).toHaveLength(2)
  })

  it("is idempotent: the same patch on the same base is the same revision", async () => {
    const world = fakeHost(FILES)
    const workspace = port(world)
    const first = await stage(workspace, { "src/users/list.ts": "guarded\n" })
    const again = await workspace.stagePatch({
      runId: "run-1",
      logicalStepId: "delegate:stage:1",
      patch: first.patch,
      signal,
    })
    expect(again).toEqual({ ok: true, revision: first.revision })
    expect(world.openings).toHaveLength(2)
  })

  it("refuses a patch whose content does not match its hash, and one on an unknown base", async () => {
    const world = fakeHost(FILES)
    const workspace = port(world)
    const base = await workspace.currentRevision()
    const forged: DelegatePatch = {
      format: "cognia-delegate-patch-1",
      base_revision: base,
      files: [
        {
          path: "src/users/list.ts",
          action: "write",
          content: "evil\n",
          content_sha256: sha256Hex("innocent\n"),
        },
      ],
    }
    await expect(
      workspace.stagePatch({ runId: "run-1", logicalStepId: "s", patch: forged, signal })
    ).resolves.toMatchObject({ ok: false, code: "PATCH_REFUSED", path: "src/users/list.ts" })

    await expect(
      workspace.stagePatch({
        runId: "run-1",
        logicalStepId: "s",
        patch: { ...forged, base_revision: "git:somewhere-else", files: [] },
        signal,
      })
    ).resolves.toMatchObject({ ok: false, code: "REVISION_UNKNOWN" })
  })

  it("[ACC:DEL-05] refuses to stage a patch naming an escape or a symlink", async () => {
    const world = fakeHost({ ...FILES, "docs/link": "" }, { symlinks: ["docs/link"] })
    const workspace = port(world)
    const base = await workspace.currentRevision()
    const patchWith = (path: string): DelegatePatch => ({
      format: "cognia-delegate-patch-1",
      base_revision: base,
      files: [{ path, action: "write", content: "x\n", content_sha256: sha256Hex("x\n") }],
    })
    for (const path of ["../outside.ts", "/etc/passwd", ".ssh/authorized_keys", "docs/link"]) {
      const result = await workspace.stagePatch({
        runId: "run-1",
        logicalStepId: "s",
        patch: patchWith(path),
        signal,
      })
      expect(result).toMatchObject({ ok: false, code: "PATCH_REFUSED", path })
    }
    expect(world.workspaceFiles()["docs/link"]).toBe("")
    expect(workspace.staged).toEqual([])
  })

  it("reports a host that will not provision a worktree instead of writing anywhere else", async () => {
    const world = fakeHost(FILES, { stagingError: "pipeline workspace is already active" })
    const workspace = port(world)
    const base = await workspace.currentRevision()
    const staged = await workspace.stagePatch({
      runId: "run-1",
      logicalStepId: "s",
      patch: patchOf(base, { "src/users/list.ts": "x\n" }),
      signal,
    })
    expect(staged).toMatchObject({ ok: false, code: "PATCH_REFUSED" })
    expect(staged.ok === false && staged.message).toContain("already active")
    expect(world.workspaceFiles()["src/users/list.ts"]).toBe("export const list = []\n")
  })

  it("gives both worktrees back when the run ends", async () => {
    const world = fakeHost(FILES)
    const workspace = port(world)
    await stage(workspace, { "src/users/list.ts": "guarded\n" })
    expect(world.openings).toHaveLength(2)
    await workspace.dispose()
    expect(world.disposals.sort()).toEqual(world.openings.map((entry) => entry.root).sort())
    // Disposing twice is not an error, and asks for nothing twice.
    await workspace.dispose()
    expect(world.disposals).toHaveLength(2)
  })
})

describe("createDelegateWorkspacePort applyPatchCAS", () => {
  it("applies a verified patch to the workspace at its base revision", async () => {
    const world = fakeHost(FILES)
    const workspace = port(world)
    const base = await workspace.currentRevision()
    const { patch } = await stage(
      workspace,
      {
        "src/users/list.ts": "export const list = guarded([])\n",
        "tests/users/list.test.ts": "test('race', () => { expect(1).toBe(1) })\n",
      },
      base
    )
    const applied = await workspace.applyPatchCAS({
      runId: "run-1",
      logicalStepId: "delegate:deliver:apply",
      patch,
      baseRevision: base,
      approvalId: "approval-1",
      signal,
    })
    expect(applied.ok).toBe(true)
    expect(world.applies).toEqual([{ taskRunId: "task-run-2", approvalId: "approval-1" }])
    expect(world.workspaceFiles()["src/users/list.ts"]).toBe("export const list = guarded([])\n")
  })

  it("[ACC:DEL-04] refuses a patch whose base no longer matches, and writes nothing", async () => {
    const world = fakeHost(FILES)
    const workspace = port(world)
    const base = await workspace.currentRevision()
    const { patch } = await stage(workspace, { "src/users/list.ts": "guarded\n" }, base)

    // The person edits the same file while the run is verifying.
    world.externalEdit("src/users/list.ts", "export const list = mine()\n")
    const before = world.workspaceFiles()

    const conflict = await workspace.applyPatchCAS({
      runId: "run-1",
      logicalStepId: "delegate:deliver:apply",
      patch,
      baseRevision: base,
      approvalId: "approval-1",
      signal,
    })
    expect(conflict).toMatchObject({ ok: false, code: "PATCH_CONFLICT" })
    expect(
      conflict.ok === false && conflict.code === "PATCH_CONFLICT" && conflict.currentRevision
    ).not.toBe(base)
    // Nothing was written, and the apply was never dispatched.
    expect(world.workspaceFiles()).toEqual(before)
    expect(world.applies).toEqual([])
  })

  it("[ACC:DEL-04] passes the host's own conflict through, still writing nothing", async () => {
    const world = fakeHost(FILES)
    const workspace = port(world)
    const base = await workspace.currentRevision()
    const { patch } = await stage(workspace, { "src/users/list.ts": "guarded\n" }, base)
    const before = world.workspaceFiles()
    // The host's compare-and-swap loses a race the port's check could not see.
    world.scriptApply({ status: "conflict", currentRevision: "git:moved-under-us" })
    const conflict = await workspace.applyPatchCAS({
      runId: "run-1",
      logicalStepId: "delegate:deliver:apply",
      patch,
      baseRevision: base,
      approvalId: "approval-1",
      signal,
    })
    expect(conflict).toMatchObject({ ok: false, code: "PATCH_CONFLICT" })
    expect(world.workspaceFiles()).toEqual(before)
  })

  it("[ACC:DEL-04] refuses a patch built on another base without touching the workspace", async () => {
    const world = fakeHost(FILES)
    const workspace = port(world)
    const base = await workspace.currentRevision()
    const refused = await workspace.applyPatchCAS({
      runId: "run-1",
      logicalStepId: "delegate:deliver:apply",
      patch: patchOf("git:another-base", { "src/users/list.ts": "x\n" }),
      baseRevision: base,
      approvalId: "approval-1",
      signal,
    })
    expect(refused).toMatchObject({ ok: false, code: "PATCH_REFUSED" })
    expect(world.applies).toEqual([])
    expect(world.workspaceFiles()["src/users/list.ts"]).toBe("export const list = []\n")
  })

  it("[ACC:DEL-05] refuses an apply that names a path outside the workspace, before writing", async () => {
    const world = fakeHost(FILES)
    const workspace = port(world)
    const base = await workspace.currentRevision()
    const patch: DelegatePatch = {
      format: "cognia-delegate-patch-1",
      base_revision: base,
      files: [
        {
          path: "src/users/list.ts",
          action: "write",
          content: "fine\n",
          content_sha256: sha256Hex("fine\n"),
        },
        {
          path: "../../../home/me/.ssh/authorized_keys",
          action: "write",
          content: "ssh-rsa key\n",
          content_sha256: sha256Hex("ssh-rsa key\n"),
        },
      ],
    }
    const refused = await workspace.applyPatchCAS({
      runId: "run-1",
      logicalStepId: "delegate:deliver:apply",
      patch,
      baseRevision: base,
      approvalId: "approval-1",
      signal,
    })
    expect(refused).toMatchObject({ ok: false, code: "PATCH_REFUSED" })
    // The legal file of the same patch was not written either: a refusal is
    // whole-patch, never partial.
    expect(world.workspaceFiles()["src/users/list.ts"]).toBe("export const list = []\n")
    expect(world.applies).toEqual([])
  })
})
