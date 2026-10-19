import { makeTask } from "../test-fixtures"
import {
  InputFileChangedError,
  MAX_DELIVERABLE_FILES,
  prepareRolloutWorkspace,
  probeDirectory,
  sha256OfBytes,
  type GitWorkspaceHandle,
  type IsolationDeps,
} from "./isolation"

const scm = {
  captureChangeset: jest.fn(),
  review: jest.fn(),
}
const workspaceClient = {
  acquireWorkspaceBundle: jest.fn(),
  ensureWorkspacePortLease: jest.fn(),
  archiveManagedWorkspace: jest.fn(),
}
const turnLease = { openWorkspaceBundleTurnLease: jest.fn() }

jest.mock("@/lib/task-workspace/client", () => workspaceClient)
jest.mock("@/lib/task-workspace/run-lease", () => turnLease)
jest.mock("@/lib/task-workspace/user-action", () => ({
  runWorkspaceUserAction: (_name: string, fn: () => unknown) => fn(),
}))
jest.mock("@/lib/scm/host", () => ({
  createScmHost: () => ({ captureChangeset: scm.captureChangeset }),
}))
jest.mock("@/lib/scm/runtime", () => ({
  createScmRuntime: () => ({ review: scm.review }),
}))
jest.mock("@/lib/files/workspace-fs", () => ({
  readWorkspaceFileBase64: jest.fn(async () => btoa("x")),
  walkWorkspace: jest.fn(async () => ({
    entries: [
      { relPath: "a.md", size: 3, isDir: false },
      { relPath: "dir", size: 0, isDir: true },
    ],
    truncated: false,
  })),
  readWorkspaceFileVersioned: jest.fn(async () => ({ content: "abc", sha256: "h", size: 3 })),
}))
jest.mock("@/lib/tauri/app-data-files", () => ({
  writeBlobToAppData: jest.fn(async (rel: string) => `/app/${rel}`),
  appDataPath: jest.fn(async (rel: string) => `/app/${rel}`),
  removeAppDataDirectory: jest.fn(async () => undefined),
}))

const CSV = "a,b\n1,2\n"
const ids = { runId: "run-1", label: "inv:1", sessionId: "s1", characterId: "agent-1" }

function fakeDeps(
  files: Record<string, string>,
  git?: GitWorkspaceHandle
): IsolationDeps & {
  writes: Map<string, string>
  removed: string[]
} {
  const writes = new Map<string, string>()
  const removed: string[] = []
  return {
    writes,
    removed,
    fs: {
      readHostFileBase64: async () => btoa(CSV),
      writeAppDataFile: async (rel, bytes) => {
        writes.set(rel, new TextDecoder().decode(bytes))
        return `/app/${rel}`
      },
      appDataPath: async (rel) => `/app/${rel}`,
      removeAppDataDirectory: async (rel) => {
        removed.push(rel)
      },
      walk: async () => ({
        files: Object.entries(files).map(([relPath, text]) => ({ relPath, size: text.length })),
        truncated: false,
      }),
      readText: async (_root, relPath, maxBytes) => {
        const text = files[relPath]
        if (text === undefined) throw new Error("binary")
        const bytes = new TextEncoder().encode(text)
        return {
          content: text.slice(0, maxBytes),
          sha256: await sha256OfBytes(bytes),
          size: bytes.length,
        }
      },
    },
    git: {
      acquire: async () => {
        if (!git) throw new Error("no git")
        return git
      },
    },
    now: () => 5,
  }
}

describe("probeDirectory", () => {
  it("keeps labels path-safe", () => {
    expect(probeDirectory("run-1", "inv:1/../x")).toBe("harness-evolution/run-1/inv_1____x")
  })
})

describe("prepareRolloutWorkspace", () => {
  it("is text-only without isolation", async () => {
    const ws = await prepareRolloutWorkspace(makeTask({ isolation: "none" }), ids, fakeDeps({}))
    expect(ws.root).toBeUndefined()
    expect(await ws.collect()).toEqual({ deliverables: [], filesObservable: false })
    await ws.release("ready")
  })

  it("copies inputs into a scratch directory and reports only new or changed files", async () => {
    const sha = await sha256OfBytes(new TextEncoder().encode(CSV))
    const deps = fakeDeps({
      ".cognia-harness-probe": "run-1",
      "data.csv": CSV,
      "report.md": "# R",
      "image.png": "\u0000",
    })
    deps.fs.readText = (() => {
      const inner = deps.fs.readText
      return async (root, rel, max) => {
        if (rel === "image.png") throw new Error("binary")
        return inner(root, rel, max)
      }
    })()
    const task = makeTask({
      inputFiles: [{ sourcePath: "/host/in/data.csv", relativePath: "data.csv", sha256: sha }],
    })
    const ws = await prepareRolloutWorkspace(task, ids, deps)
    expect(ws.kind).toBe("files")
    expect(ws.root).toBe("/app/harness-evolution/run-1/inv_1/work")
    expect(ws.project?.roots[0].path).toBe(ws.root)
    expect(deps.writes.get("harness-evolution/run-1/inv_1/work/data.csv")).toBe(CSV)
    expect(deps.writes.get("harness-evolution/run-1/inv_1/work/.cognia-harness-probe")).toBe(
      "run-1"
    )
    const collected = await ws.collect()
    expect(collected.filesObservable).toBe(true)
    expect(collected.deliverables).toEqual([
      expect.objectContaining({ path: "report.md", text: "# R", bytes: 3 }),
      { path: "image.png", bytes: 1 },
    ])
    await ws.release("ready")
    await ws.release("ready")
    expect(deps.removed).toEqual(["harness-evolution/run-1/inv_1"])
  })

  it("refuses an input that changed since the task was created", async () => {
    const task = makeTask({
      inputFiles: [{ sourcePath: "/host/data.csv", relativePath: "data.csv", sha256: "stale" }],
    })
    await expect(prepareRolloutWorkspace(task, ids, fakeDeps({}))).rejects.toBeInstanceOf(
      InputFileChangedError
    )
  })

  it("caps how many deliverables are read", async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < MAX_DELIVERABLE_FILES + 2; i++) files[`f${i}.txt`] = "x"
    const ws = await prepareRolloutWorkspace(makeTask(), ids, fakeDeps(files))
    const { deliverables } = await ws.collect()
    expect(deliverables).toHaveLength(MAX_DELIVERABLE_FILES + 2)
    expect(deliverables.at(-1)).toEqual({
      path: `f${MAX_DELIVERABLE_FILES + 1}.txt`,
      bytes: 1,
      truncated: true,
    })
  })

  it("uses a git workspace, settles once and archives on release", async () => {
    const settle = jest.fn(async () => ["src/a.ts"])
    const archive = jest.fn(async () => undefined)
    const acceptance = jest.fn(async () => new Map([["unit", { outcome: "passed" as const }]]))
    const deps = fakeDeps(
      { "src/a.ts": "export {}", "src/b.ts": "x" },
      {
        root: "/wt",
        workspaceId: "w1",
        settle,
        acceptance,
        archive,
      }
    )
    const ws = await prepareRolloutWorkspace(makeTask({ isolation: "git" }), ids, deps)
    expect(ws.root).toBe("/wt")
    const { deliverables } = await ws.collect()
    expect(deliverables.map((d) => d.path)).toEqual(["src/a.ts"])
    expect(await ws.acceptance?.(["unit"], new AbortController().signal)).toEqual(
      new Map([["unit", { outcome: "passed" }]])
    )
    await ws.release("ready")
    await ws.release("failed")
    expect(settle).toHaveBeenCalledTimes(1)
    expect(archive).toHaveBeenCalledTimes(1)
  })

  it("archives a git workspace even when settling fails", async () => {
    const archive = jest.fn(async () => undefined)
    const deps = fakeDeps(
      {},
      {
        root: "/wt",
        workspaceId: "w1",
        settle: async () => {
          throw new Error("settle failed")
        },
        archive,
      }
    )
    const ws = await prepareRolloutWorkspace(makeTask({ isolation: "git" }), ids, deps)
    await expect(ws.release("failed")).rejects.toThrow("settle failed")
    expect(archive).toHaveBeenCalled()
    expect(ws.acceptance).toBeUndefined()
  })
})

describe("defaultIsolationDeps", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    workspaceClient.acquireWorkspaceBundle.mockResolvedValue({
      state: "active",
      leases: [{ role: "primary", workspaceId: "w1" }],
    })
    workspaceClient.ensureWorkspacePortLease.mockResolvedValue({ canonicalRoot: "/wt" })
    workspaceClient.archiveManagedWorkspace.mockResolvedValue(undefined)
    turnLease.openWorkspaceBundleTurnLease.mockResolvedValue({
      settle: jest.fn(async () => [{ path: "src/a.ts" }]),
    })
  })

  it("wires the host filesystem and app-data helpers", async () => {
    const { defaultIsolationDeps } = await import("./isolation")
    const deps = await defaultIsolationDeps()
    expect(await deps.fs.walk("/r")).toEqual({
      files: [{ relPath: "a.md", size: 3 }],
      truncated: false,
    })
    expect(await deps.fs.readText("/r", "a.md", 10)).toEqual({
      content: "abc",
      sha256: "h",
      size: 3,
    })
    expect(await deps.fs.writeAppDataFile("x/y", new Uint8Array([1]))).toBe("/app/x/y")
    expect(await deps.fs.readHostFileBase64("/r", "a")).toBe(btoa("x"))
  })

  it("acquires a managed bundle at the frozen base and runs acceptance on a changeset", async () => {
    const { defaultIsolationDeps } = await import("./isolation")
    const deps = await defaultIsolationDeps()
    const task = makeTask({
      isolation: "git",
      git: { sourceRoot: "/repo", resolvedBaseSha: "abc123", projectId: "proj" },
    })
    const handle = await deps.git.acquire({ task, ...ids })
    expect(workspaceClient.acquireWorkspaceBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerRef: "s1",
        environmentKind: "managed",
        base: { kind: "gitRef", gitRef: "abc123" },
        projectId: "proj",
      })
    )
    expect(handle.root).toBe("/wt")
    expect(await handle.settle("ready")).toEqual(["src/a.ts"])

    scm.captureChangeset.mockResolvedValue({ changesetId: "c1" })
    scm.review.mockResolvedValue({
      checks: [{ profileId: "unit", outcome: "failed", logTail: "1 failing" }],
    })
    const outcomes = await handle.acceptance!(["unit", "lint"], new AbortController().signal)
    expect(outcomes.get("unit")).toEqual({ outcome: "failed", detail: "1 failing" })
    expect(outcomes.get("lint")).toEqual({
      outcome: "inconclusive",
      detail: "the profile did not run",
    })

    scm.captureChangeset.mockRejectedValue(new Error("nothing_to_capture"))
    const empty = await handle.acceptance!(["unit"], new AbortController().signal)
    expect(empty.get("unit")?.outcome).toBe("inconclusive")

    await handle.archive()
    expect(workspaceClient.archiveManagedWorkspace).toHaveBeenCalledWith("w1")
  })

  it("needs a resolved base and archives when the turn cannot be leased", async () => {
    const { defaultIsolationDeps } = await import("./isolation")
    const deps = await defaultIsolationDeps()
    await expect(
      deps.git.acquire({
        task: makeTask({ isolation: "git", git: { sourceRoot: "/repo" } }),
        ...ids,
      })
    ).rejects.toThrow(/resolved base commit/)
    turnLease.openWorkspaceBundleTurnLease.mockResolvedValue(null)
    await expect(
      deps.git.acquire({
        task: makeTask({ isolation: "git", git: { sourceRoot: "/repo", resolvedBaseSha: "abc" } }),
        ...ids,
      })
    ).rejects.toThrow(/could not be leased/)
    expect(workspaceClient.archiveManagedWorkspace).toHaveBeenCalledWith("w1")
  })
})
