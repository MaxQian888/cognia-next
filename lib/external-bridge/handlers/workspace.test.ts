import {
  __setWorkspaceBridgeDepsForTests,
  scrubHostPaths,
  workspaceToolCore,
  WORKSPACE_BRIDGE_PER_CALL_CONSENT_ID,
  type WorkspaceBridgeDeps,
} from "./workspace"
import { JobAttention } from "../workspace/attention"
import type { GitStatus } from "@/types/git"

jest.mock("@/lib/tauri", () => ({ isTauri: () => true }))
jest.mock("@/lib/external-bridge/orchestration-proxy-client", () => ({
  proxyToRenderer: jest.fn(),
}))
jest.mock("@/lib/db/projects", () => ({ getAllProjects: jest.fn(async () => []) }))
jest.mock("@/lib/db/settings", () => ({ getSettings: jest.fn(async () => ({})) }))
jest.mock("@/lib/tauri/events", () => ({
  TAURI_EVENTS: { backgroundJobExited: "jobs://exited" },
  onTauriEvent: jest.fn(async () => () => undefined),
}))

const CLIENT = "mcp:c1"
const ROOT = "/work/app"

const EMPTY_STATUS: GitStatus = {
  branch: "main",
  upstream: null,
  ahead: 0,
  behind: 0,
  staged: [],
  changes: [],
  merge: [],
  isRebasing: false,
  isMerging: false,
}

function makeDeps(over: Partial<WorkspaceBridgeDeps> = {}) {
  const files = new Map<string, string>([
    ["src/a.ts", "line1\nline2\nline3"],
    ["README.md", "contact alice@example.com"],
  ])
  let clock = 0
  const deps: WorkspaceBridgeDeps = {
    grants: {
      loadSettings: async () => ({
        enabled: true,
        enabledScopes: [],
        workspaceGrants: { [CLIENT]: ["root-a"] },
      }),
      loadProjects: async () =>
        [{ id: "p", name: "App", roots: [{ id: "root-a", path: ROOT, isPrimary: true }] }] as never,
    },
    fs: {
      walk: jest.fn(async () => ({
        entries: [
          { relPath: "src", absolutePath: `${ROOT}/src`, isDir: true, size: 0, mtimeMs: null },
          {
            relPath: "src/a.ts",
            absolutePath: `${ROOT}/src/a.ts`,
            isDir: false,
            size: 17,
            mtimeMs: null,
          },
          {
            relPath: "node_modules/x/i.js",
            absolutePath: "",
            isDir: false,
            size: 1,
            mtimeMs: null,
          },
          { relPath: ".git/HEAD", absolutePath: "", isDir: false, size: 1, mtimeMs: null },
        ],
        truncated: false,
        skippedSensitive: 1,
      })),
      stat: jest.fn(async (_root: string, rel: string) =>
        files.has(rel)
          ? { exists: true, isDir: false, size: files.get(rel)!.length, mtimeMs: null }
          : rel === "" || rel === "src" || rel === ".git"
            ? { exists: true, isDir: true, size: 0, mtimeMs: null }
            : { exists: false, isDir: false, size: 0, mtimeMs: null }
      ),
      read: jest.fn(async (_root: string, rel: string) => files.get(rel) ?? ""),
      searchContent: jest.fn(async () => [
        { relPath: "src/a.ts", absolutePath: "", line: 2, column: 1, preview: "line2" },
        { relPath: ".env", absolutePath: "", line: 1, column: 1, preview: "TOKEN=x" },
      ]),
      searchNames: jest.fn(async () => []),
      write: jest.fn(async (_root: string, rel: string, content: string) => {
        files.set(rel, content)
      }),
      rename: jest.fn(async () => undefined),
      remove: jest.fn(async () => undefined),
    },
    git: {
      isRepo: jest.fn(async () => true),
      status: jest.fn(async () => ({
        ...EMPTY_STATUS,
        changes: [
          { path: "src/a.ts", origPath: null, status: "modified", staged: false, group: "changes" },
          { path: ".env", origPath: null, status: "modified", staged: false, group: "changes" },
        ],
      })) as WorkspaceBridgeDeps["git"]["status"],
      diffFile: jest.fn(async (_r: string, path: string) => ({
        path,
        oldContent: "",
        newContent: "",
        isBinary: false,
        hunks: [
          {
            header: "",
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            patch: "@@ -1 +1 @@",
            lines: [],
          },
        ],
      })),
      workspaceDiff: jest.fn(async (repoPath, options) => {
        const status = await options.status(repoPath)
        return {
          text: status.changes.map((c) => c.path).join(","),
          fileCount: status.changes.length,
          truncated: false,
        }
      }),
      log: jest.fn(async () => [
        {
          hash: "abc",
          shortHash: "abc",
          summary: "fix",
          body: "",
          authorName: "Ann",
          authorEmail: "ann@example.com",
          authoredAtMs: 0,
          parents: [],
        },
      ]),
      fileHistory: jest.fn(async () => []),
      commitFiles: jest.fn(async () => [
        { path: "src/a.ts", origPath: null, status: "modified", staged: false, group: "changes" },
        { path: "id_rsa", origPath: null, status: "added", staged: false, group: "changes" },
      ]) as WorkspaceBridgeDeps["git"]["commitFiles"],
      diffCommit: jest.fn(async (_r: string, _s: string, path: string) => ({
        path,
        oldContent: "",
        newContent: "",
        isBinary: false,
        hunks: [],
      })),
    },
    jobs: {
      spawn: jest.fn(async () => ({ id: "job-1" }) as never),
      wait: jest.fn(async () => ({
        fromOffset: 0,
        nextOffset: 3,
        data: "ok\n",
        status: "exited" as const,
        exitCode: 0,
        hasMore: false,
      })),
      list: jest.fn(async () => [
        { id: "job-1", command: "pnpm test", status: "running", startedAtMs: 0 } as never,
      ]),
      kill: jest.fn(async () => ({ id: "job-1", status: "killed" }) as never),
    },
    classify: jest.fn(() => ({ verdict: "allow", reason: "safe", segments: [] }) as never),
    requestConsent: jest.fn(async () => true),
    translate: jest.fn(async (key: string) => key),
    redact: (text: string) => {
      const out = text.replace(/[\w.]+@example\.com/g, "<EMAIL_001>")
      return { text: out, redacted: out !== text }
    },
    hasPlaceholder: (text: string) => /<EMAIL_\d{3,}>/.test(text),
    piiFree: () => true,
    attention: new JobAttention(async () => () => undefined),
    now: () => (clock += 1000),
    hostSupported: () => true,
    ...over,
  }
  __setWorkspaceBridgeDepsForTests(deps)
  return { deps, files }
}

const call = (tool: string, args: Record<string, unknown> = {}, clientId = CLIENT) =>
  workspaceToolCore({ tool, args, clientId }) as Promise<Record<string, unknown>>

afterEach(() => __setWorkspaceBridgeDepsForTests(null))

describe("grants and validation", () => {
  it("lists only granted roots without absolute paths", async () => {
    makeDeps()
    expect(await call("workspace_roots")).toEqual({
      ok: true,
      roots: [{ id: "root-a", label: "app", workspace: "App" }],
    })
    const none = await call("workspace_roots", {}, "mcp:other")
    expect(none.roots).toEqual([])
    expect(none.note).toMatch(/Workspace access/)
  })

  it("refuses an ungranted root with a mechanically followable follow-up", async () => {
    makeDeps()
    const out = await call("workspace_read", { root: "root-x", path: "src/a.ts" })
    expect(out).toMatchObject({
      ok: false,
      code: "root_not_granted",
      failureStage: "authorization",
      stateChanged: false,
      followUp: { tool: "workspace_roots", mechanicallyFollowable: true },
    })
  })

  it("rejects unknown tools", async () => {
    makeDeps()
    expect(await call("rm_rf")).toMatchObject({ ok: false, code: "unknown_tool" })
  })
})

describe("workspace:read", () => {
  it("lists entries, hiding secret and bulk paths with counts", async () => {
    makeDeps()
    const out = await call("workspace_list", { root: "root-a" })
    expect(out.entries).toEqual([
      { path: "src", dir: true },
      { path: "src/a.ts", size: 17 },
    ])
    expect(out.hidden).toEqual({ secret: 2, bulk: 1 })
  })

  it("reports clamped inputs", async () => {
    makeDeps()
    const out = await call("workspace_list", { root: "root-a", depth: 99 })
    expect(out.adjusted).toEqual({ depth: { requested: 99, effective: 8 } })
  })

  it("reads a line window and points at the next window", async () => {
    makeDeps()
    const out = await call("workspace_read", { root: "root-a", path: "src/a.ts", limit: 2 })
    expect(out.content).toBe("line1\nline2")
    expect(out.lines).toEqual({ from: 1, to: 2, total: 3 })
    expect(out.next).toEqual({
      tool: "workspace_read",
      arguments: { root: "root-a", path: "src/a.ts", offset: 3, limit: 2 },
    })
  })

  it("redacts personal data and flags it", async () => {
    makeDeps()
    const out = await call("workspace_read", { root: "root-a", path: "README.md" })
    expect(out.content).toBe("contact <EMAIL_001>")
    expect(out.redacted).toBe(true)
  })

  it("refuses credential paths, escaping paths and symlinks", async () => {
    const { deps } = makeDeps()
    expect(await call("workspace_read", { root: "root-a", path: ".env" })).toMatchObject({
      code: "secret_path",
    })
    expect(await call("workspace_read", { root: "root-a", path: "../x" })).toMatchObject({
      code: "invalid_path",
    })
    jest.mocked(deps.fs.stat).mockResolvedValueOnce({
      exists: true,
      isDir: false,
      size: 1,
      mtimeMs: null,
      isSymlink: true,
    })
    expect(await call("workspace_read", { root: "root-a", path: "link" })).toMatchObject({
      code: "symlink_not_followed",
    })
    expect(deps.fs.read).not.toHaveBeenCalled()
  })

  it("withholds a result the PII gate still rejects", async () => {
    makeDeps({ piiFree: () => false })
    expect(await call("workspace_read", { root: "root-a", path: "src/a.ts" })).toMatchObject({
      ok: false,
      code: "pii_blocked",
    })
  })

  it("filters content search hits to ordinary paths", async () => {
    makeDeps()
    const out = await call("workspace_search", { root: "root-a", query: "line" })
    expect(out.matches).toEqual([{ path: "src/a.ts", line: 2, text: "line2" }])
  })
})

describe("workspace:write", () => {
  it("refuses a create over an existing file, with a non-mechanical follow-up", async () => {
    makeDeps()
    const out = await call("workspace_write", {
      root: "root-a",
      path: "src/a.ts",
      content: "x",
      mode: "create",
    })
    expect(out).toMatchObject({
      code: "already_exists",
      followUp: { mechanicallyFollowable: false },
    })
  })

  it("refuses content that carries a redaction placeholder", async () => {
    const { deps } = makeDeps()
    const out = await call("workspace_write", {
      root: "root-a",
      path: "README.md",
      content: "contact <EMAIL_001>",
    })
    expect(out).toMatchObject({ code: "redaction_placeholder", stateChanged: false })
    expect(deps.fs.write).not.toHaveBeenCalled()
  })

  it("edits a unique match and refuses an ambiguous one", async () => {
    const { files } = makeDeps()
    expect(
      await call("workspace_edit", {
        root: "root-a",
        path: "src/a.ts",
        oldString: "line2",
        newString: "L2",
      })
    ).toMatchObject({ ok: true, replacements: 1 })
    expect(files.get("src/a.ts")).toBe("line1\nL2\nline3")
    expect(
      await call("workspace_edit", {
        root: "root-a",
        path: "src/a.ts",
        oldString: "line",
        newString: "x",
      })
    ).toMatchObject({ code: "ambiguous_match", followUp: { mechanicallyFollowable: false } })
    expect(
      await call("workspace_edit", {
        root: "root-a",
        path: "src/a.ts",
        oldString: "zzz",
        newString: "x",
      })
    ).toMatchObject({
      code: "no_match",
      followUp: { tool: "workspace_read", mechanicallyFollowable: true },
    })
  })

  it("never moves onto an existing destination or a secret path", async () => {
    makeDeps()
    expect(
      await call("workspace_move", { root: "root-a", from: "src/a.ts", to: "README.md" })
    ).toMatchObject({
      code: "already_exists",
    })
    expect(
      await call("workspace_move", { root: "root-a", from: "src/a.ts", to: ".env" })
    ).toMatchObject({
      code: "secret_path",
    })
  })

  it("asks per call before a delete and honours a refusal", async () => {
    const { deps } = makeDeps({ requestConsent: jest.fn(async () => false) })
    expect(await call("workspace_delete", { root: "root-a", path: "src/a.ts" })).toMatchObject({
      code: "approval_denied",
      failureStage: "consent",
    })
    expect(deps.requestConsent).toHaveBeenCalledWith({
      consentId: WORKSPACE_BRIDGE_PER_CALL_CONSENT_ID,
      reason: "workspaceApproval.deleteReason",
    })
    expect(deps.fs.remove).not.toHaveBeenCalled()
    expect(await call("workspace_delete", { root: "root-a", path: "" })).toMatchObject({
      code: "invalid_path",
    })
  })

  it("marks a host failure mid-write as outcome unknown", async () => {
    makeDeps()
    const { deps } = makeDeps()
    jest.mocked(deps.fs.write).mockRejectedValueOnce(new Error("disk full"))
    expect(
      await call("workspace_write", { root: "root-a", path: "n.txt", content: "x" })
    ).toMatchObject({
      code: "host_error",
      outcomeUnknown: true,
    })
  })
})

describe("git:read", () => {
  it("leaves credential paths out of the status", async () => {
    makeDeps()
    const out = await call("git_status", { root: "root-a" })
    expect(out.changes).toEqual([{ path: "src/a.ts", status: "modified" }])
    expect(out.hidden).toEqual({ secret: 1 })
  })

  it("diffs the whole tree through the filtered status", async () => {
    makeDeps()
    expect(await call("git_diff", { root: "root-a" })).toMatchObject({ diff: "src/a.ts", files: 1 })
    expect(await call("git_diff", { root: "root-a", path: ".env" })).toMatchObject({
      code: "secret_path",
    })
  })

  it("drops author e-mail from the log and pages with next", async () => {
    makeDeps()
    const out = await call("git_log", { root: "root-a", limit: 1 })
    expect(out.commits).toEqual([
      { hash: "abc", summary: "fix", author: "Ann", date: "1970-01-01T00:00:00.000Z" },
    ])
    expect(out.next).toEqual({ tool: "git_log", arguments: { root: "root-a", limit: 1, skip: 1 } })
  })

  it("hides secret files in a commit and refuses option-looking revs", async () => {
    makeDeps()
    const out = await call("git_show", { root: "root-a", rev: "abc" })
    expect(out.files).toEqual([{ path: "src/a.ts", status: "modified" }])
    expect(out.hidden).toEqual({ secret: 1 })
    expect(await call("git_show", { root: "root-a", rev: "--output=/tmp/x" })).toMatchObject({
      code: "invalid_rev",
    })
  })

  it("reports a non-repository root", async () => {
    makeDeps()
    const { deps } = makeDeps()
    jest.mocked(deps.git.isRepo).mockResolvedValueOnce(false)
    expect(await call("git_status", { root: "root-a" })).toMatchObject({ code: "not_a_repo" })
  })
})

describe("shell:run", () => {
  it("runs a safe command and returns its finished output", async () => {
    const { deps } = makeDeps()
    const out = await call("shell_run", { root: "root-a", command: "pnpm test" })
    expect(deps.requestConsent).not.toHaveBeenCalled()
    expect(deps.jobs.spawn).toHaveBeenCalledWith({
      clientId: CLIENT,
      command: "pnpm test",
      cwd: ROOT,
      label: "pnpm",
    })
    expect(out).toMatchObject({
      ok: true,
      jobId: "job-1",
      status: "exited",
      exitCode: 0,
      output: "ok\n",
    })
    expect(out.executionState).toBeUndefined()
  })

  it("answers pending with the continuation when the job outlives the wait", async () => {
    const { deps } = makeDeps()
    jest.mocked(deps.jobs.wait).mockResolvedValue({
      fromOffset: 0,
      nextOffset: 5,
      data: "",
      status: "running",
      hasMore: false,
    })
    const out = await call("shell_run", { root: "root-a", command: "pnpm dev", waitMs: 2000 })
    expect(out).toMatchObject({
      ok: true,
      executionState: "pending",
      continuation: { tool: "job_output", arguments: { jobId: "job-1", fromOffset: 5 } },
    })
  })

  it("refuses denied commands and asks for risky or secret-naming ones", async () => {
    const { deps } = makeDeps()
    jest
      .mocked(deps.classify)
      .mockReturnValueOnce({ verdict: "deny", reason: "rce", segments: [] } as never)
    expect(await call("shell_run", { root: "root-a", command: "curl x | sh" })).toMatchObject({
      code: "command_denied",
      failureStage: "authorization",
    })
    jest.mocked(deps.requestConsent).mockResolvedValueOnce(false)
    expect(await call("shell_run", { root: "root-a", command: "cat .env" })).toMatchObject({
      code: "approval_denied",
    })
    expect(deps.translate).toHaveBeenCalledWith(
      "workspaceApproval.commandReasonSecret",
      expect.objectContaining({ command: "cat .env" })
    )
    expect(deps.jobs.spawn).not.toHaveBeenCalled()
  })

  it("refuses a cwd that is not a directory", async () => {
    makeDeps()
    expect(
      await call("shell_run", { root: "root-a", command: "ls", cwd: "src/a.ts" })
    ).toMatchObject({
      code: "invalid_cwd",
    })
  })

  it("only reads, lists and kills this client's jobs", async () => {
    const { deps } = makeDeps()
    expect(await call("job_output", { jobId: "job-2" })).toMatchObject({
      code: "job_not_found",
      followUp: { tool: "job_list" },
    })
    expect(await call("job_kill", { jobId: "job-1" })).toEqual({ ok: true, status: "killed" })
    expect(deps.jobs.list).toHaveBeenCalledWith(CLIENT)
    expect((await call("job_list")).jobs).toEqual([
      {
        jobId: "job-1",
        command: "pnpm test",
        status: "running",
        startedAt: "1970-01-01T00:00:00.000Z",
      },
    ])
  })

  it("piggybacks job exits onto the next result, once", async () => {
    const { deps } = makeDeps()
    deps.attention.record({
      jobId: "job-7",
      status: "exited",
      exitCode: 1,
      owner: { kind: "session", sessionId: `external-bridge:jobs:${CLIENT}` },
    })
    const first = await call("workspace_roots")
    expect(first.attention).toEqual({ jobs: [{ jobId: "job-7", status: "exited", exitCode: 1 }] })
    expect((await call("workspace_roots")).attention).toBeUndefined()
  })
})

describe("review fixes", () => {
  it("answers desktop_only on a headless or remote-controlled host", async () => {
    const { deps } = makeDeps({ hostSupported: () => false })
    expect(await call("shell_run", { root: "root-a", command: "ls" })).toMatchObject({
      code: "desktop_only",
      stateChanged: false,
    })
    expect(deps.jobs.spawn).not.toHaveBeenCalled()
  })

  it("refuses git tools on a root nested inside a larger repository", async () => {
    const { deps } = makeDeps()
    const stat = jest.mocked(deps.fs.stat)
    stat.mockImplementation(async () => ({ exists: false, isDir: false, size: 0, mtimeMs: null }))
    expect(await call("git_status", { root: "root-a" })).toMatchObject({
      code: "not_repo_root",
    })
    expect(deps.git.status).not.toHaveBeenCalled()
    jest.mocked(deps.git.isRepo).mockResolvedValueOnce(false)
    expect(await call("git_log", { root: "root-a" })).toMatchObject({ code: "not_a_repo" })
  })

  it("never labels a job with a leading env assignment's value", async () => {
    const { deps } = makeDeps()
    await call("shell_run", { root: "root-a", command: "GITHUB_TOKEN=ghp_x API=1 npm test" })
    expect(deps.jobs.spawn).toHaveBeenCalledWith(expect.objectContaining({ label: "npm" }))
  })

  it("scrubs absolute root and home paths from host errors", async () => {
    const { deps } = makeDeps()
    jest
      .mocked(deps.fs.read)
      .mockRejectedValueOnce(
        new Error(`canonicalize ${ROOT}/src/a.ts: denied (home /Users/alice/x)`)
      )
    const out = await call("workspace_read", { root: "root-a", path: "src/a.ts" })
    expect(out.error).toBe("canonicalize <root:root-a>/src/a.ts: denied (home ~/x)")
    expect(scrubHostPaths("C:\\Users\\bob\\repo", [])).toBe("~\\repo")
  })

  it("serves only whole lines when the byte budget truncates a file", async () => {
    const { deps } = makeDeps()
    jest.mocked(deps.fs.stat).mockResolvedValueOnce({
      exists: true,
      isDir: false,
      size: 5_000_000,
      mtimeMs: null,
    })
    jest.mocked(deps.fs.read).mockResolvedValueOnce("one\ntwo\nthr\n... (truncated)")
    const out = await call("workspace_read", { root: "root-a", path: "big.log" })
    expect(out.content).toBe("one\ntwo")
    expect(out.lines).toEqual({ from: 1, to: 2, total: null })
    expect(out.truncatedAtBytes).toBe(256 * 1024)
  })

  it("reports an offset past the end as clamped", async () => {
    makeDeps()
    const out = await call("workspace_read", { root: "root-a", path: "src/a.ts", offset: 50 })
    expect(out.adjusted).toEqual({ offset: { requested: 50, effective: 3 } })
  })
})
