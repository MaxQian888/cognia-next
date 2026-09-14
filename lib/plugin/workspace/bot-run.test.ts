import { webcrypto } from "node:crypto"
import { execFileSync } from "node:child_process"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  acquireBotWorkspace,
  assertOwnedBotWorkspace,
  captureBotWorkspace,
  publishBotWorkspace,
} from "./bot-run"
import type { BotRunWorkspaceSpec } from "./bot-run"
import type { AcquireDeps } from "./acquire"
import { resolveBotIntegrationBinding } from "../api/bot-integration-binding"
import { gitReadBlobAtRef, gitLog, gitStatus, gitDiffRefsFiles } from "@/lib/git/commands"
import { readWorkspaceFile, statWorkspaceFile, writeWorkspaceFile } from "@/lib/files/workspace-fs"
import { authenticatedIntegrationRequest } from "@/lib/integrations/action-runner"
import { isRemoteHostActive } from "@/lib/tauri/transport-routing"
import { updateBotInstallation } from "@/lib/db/bot-installations"
import { assertBotPublicationAuthority } from "@/lib/bot/policy/run-authority"
jest.mock("@/lib/bot/policy/run-authority", () => ({
  assertBotPublicationAuthority: jest.fn(async () => undefined),
}))
jest.mock("@/lib/tauri/transport-routing", () => ({ isRemoteHostActive: jest.fn(() => false) }))
jest.mock("@/lib/db/bot-installations", () => ({ updateBotInstallation: jest.fn() }))

const mockSteps = new Map<string, unknown>()
const mockApproval = jest.fn()
jest.mock("@/lib/db/bot-run-steps", () => ({
  getBotRunStep: jest.fn(async (run, name) =>
    mockSteps.has(`${run}:${name}`)
      ? { status: "completed", output: mockSteps.get(`${run}:${name}`) }
      : undefined
  ),
  completeBotRunStep: jest.fn(async (run, name, value) => {
    if (!mockSteps.has(`${run}:${name}`)) mockSteps.set(`${run}:${name}`, value)
  }),
}))
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({ executionRunInterrupts: { get: mockApproval } }),
}))
jest.mock("../api/bot-integration-binding", () => ({
  resolveBotIntegrationBinding: jest.fn(),
  canonicalIntegrationValue: (value: unknown) => JSON.stringify(value),
}))
jest.mock("@/lib/git/commands", () => ({
  gitReadBlobAtRef: jest.fn(),
  gitLog: jest.fn(),
  gitStatus: jest.fn(),
  gitDiffRefsFiles: jest.fn(),
}))
jest.mock("@/lib/files/workspace-fs", () => ({
  readWorkspaceFile: jest.fn(),
  statWorkspaceFile: jest.fn(),
  writeWorkspaceFile: jest.fn(),
}))
jest.mock("@/lib/integrations/action-runner", () => ({
  authenticatedIntegrationRequest: jest.fn(),
}))

const spec: BotRunWorkspaceSpec = {
  kind: "bot-run",
  runId: "run",
  repository: "org/repo",
  ref: "base",
  targetRef: "master",
  credentialSlot: "github",
}
let deps: AcquireDeps
beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(isRemoteHostActive).mockReturnValue(false)
  mockSteps.clear()
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true })
  deps = {
    openRoots: () => [],
    repoCacheDir: jest.fn(async (parts) => `/cache/${parts.join("/")}`),
    removeRepoCache: jest.fn(),
    clone: jest.fn(async (_url, dir) => dir),
    checkoutRef: jest.fn(),
    headOf: jest.fn(async () => "base"),
  }
  jest.mocked(resolveBotIntegrationBinding).mockResolvedValue({
    repository: "org/repo",
    installation: { id: "installation" },
    account: { pluginId: "github-delivery", id: "account" },
  } as never)
  jest.mocked(gitLog).mockResolvedValue([{ hash: "base" }] as never)
  jest.mocked(gitStatus).mockResolvedValue({
    staged: [],
    changes: [{ path: "a.ts", status: "modified" }],
    merge: [],
  } as never)
  jest.mocked(gitDiffRefsFiles).mockResolvedValue([])
  jest.mocked(gitReadBlobAtRef).mockResolvedValue("before\n")
  jest.mocked(statWorkspaceFile).mockResolvedValue({
    exists: true,
    isDir: false,
    size: 10,
    mtimeMs: 0,
    mode: 0o100755,
    isSymlink: false,
  })
  jest.mocked(readWorkspaceFile).mockResolvedValue("after\n")
  jest.mocked(writeWorkspaceFile).mockResolvedValue(undefined)
})

it("preserves local Git excludes and skips rewriting an already provisioned checkout", async () => {
  let excludes = "# existing\n/user-cache/"
  jest
    .mocked(readWorkspaceFile)
    .mockImplementation(async (_root, path) =>
      path === ".git/info/exclude" ? excludes : "after\n"
    )
  jest.mocked(writeWorkspaceFile).mockImplementation(async (_root, _path, content) => {
    excludes = content
  })
  const handle = await acquireBotWorkspace("plugin", spec, deps)
  expect(excludes).toContain("# existing\n/user-cache/\n")
  expect(excludes).toContain("/.pnpm-store/\n/.jest-cache/\n/node_modules/.cache/\n")
  await acquireBotWorkspace("plugin", spec, deps)
  expect(writeWorkspaceFile).toHaveBeenCalledTimes(1)
  expect(handle.runtimeStateRoot).not.toBe(handle.root)
})

it("creates missing excludes and refuses incomplete or unsafe existing Git metadata", async () => {
  jest
    .mocked(statWorkspaceFile)
    .mockResolvedValueOnce({ exists: false, isDir: false, size: 0, mtimeMs: null })
  await acquireBotWorkspace("plugin", spec, deps)
  expect(writeWorkspaceFile).toHaveBeenCalledWith(
    expect.any(String),
    ".git/info/exclude",
    expect.stringContaining("/.pnpm-store/")
  )
  for (const stat of [
    { isDir: true, isSymlink: false, size: 0 },
    { isDir: false, isSymlink: true, size: 1 },
    { isDir: false, isSymlink: false, size: 1024 * 1024 + 1 },
  ]) {
    jest.mocked(statWorkspaceFile).mockResolvedValueOnce({ ...stat, exists: true, mtimeMs: null })
    await expect(acquireBotWorkspace("plugin", spec, deps)).rejects.toThrow(
      "excludes cannot be updated completely"
    )
  }
})

it("excludes generated package caches through Git while retaining tracked and staged cache files in snapshots", async () => {
  const root = mkdtempSync(join(tmpdir(), "cognia-bot-cache-"))
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
  const write = (path: string, content: string) => {
    const file = join(root, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content)
  }
  try {
    git("init", "--quiet")
    write(".pnpm-store/tracked.txt", "original\n")
    git("add", ".pnpm-store/tracked.txt")
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture"
    )
    deps.clone = jest.fn(async () => root)
    jest.mocked(statWorkspaceFile).mockImplementation(async (directory, path) => {
      const file = join(directory, path)
      if (!existsSync(file)) return { exists: false, isDir: false, size: 0, mtimeMs: null }
      const stat = lstatSync(file)
      return {
        exists: true,
        isDir: stat.isDirectory(),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        mode: stat.mode,
        isSymlink: stat.isSymbolicLink(),
      }
    })
    jest
      .mocked(readWorkspaceFile)
      .mockImplementation(async (directory, path) => readFileSync(join(directory, path), "utf8"))
    jest
      .mocked(writeWorkspaceFile)
      .mockImplementation(async (_directory, path, content) => write(path, content))
    const handle = await acquireBotWorkspace("plugin", spec, deps)
    write(".pnpm-store/generated.bin", "package cache")
    write(".jest-cache/generated.bin", "test cache")
    write("node_modules/.cache/generated.bin", "tool cache")
    write(".pnpm-store/tracked.txt", "modified source\n")
    write(".jest-cache/staged.txt", "intentionally staged\n")
    git("add", "--force", ".jest-cache/staged.txt")
    const status = git("status", "--porcelain=v1", "--untracked-files=all")
    expect(status).not.toContain("generated.bin")
    expect(status).toContain(" M .pnpm-store/tracked.txt")
    expect(status).toContain("A  .jest-cache/staged.txt")
    jest.mocked(gitStatus).mockResolvedValue({
      merge: [],
      changes: [{ path: ".pnpm-store/tracked.txt", status: "modified" }],
      staged: [{ path: ".jest-cache/staged.txt", status: "added" }],
    } as never)
    jest
      .mocked(gitReadBlobAtRef)
      .mockImplementation(async (_directory, _ref, path) =>
        path === ".pnpm-store/tracked.txt" ? "original\n" : null
      )
    const snapshot = await captureBotWorkspace("plugin", handle)
    expect(snapshot.files.map((file) => file.path)).toEqual([
      ".jest-cache/staged.txt",
      ".pnpm-store/tracked.txt",
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it("marks an unsupported paired host needs_setup before allocating a cache", async () => {
  jest.mocked(isRemoteHostActive).mockReturnValue(true)
  await expect(acquireBotWorkspace("plugin", spec, deps)).rejects.toThrow("execution host")
  expect(updateBotInstallation).toHaveBeenCalledWith(
    "installation",
    expect.objectContaining({ status: "needs_setup", monitor: { lastError: expect.any(String) } })
  )
  expect(deps.repoCacheDir).not.toHaveBeenCalled()
})

it("captures mode-only changes and refuses symlink or unavailable stat modes", async () => {
  const handle = await acquireBotWorkspace("plugin", spec, deps)
  jest.mocked(readWorkspaceFile).mockResolvedValue("before\n")
  const snapshot = await captureBotWorkspace("plugin", handle)
  expect(snapshot.files[0].mode).toBe("100755")
  jest.mocked(statWorkspaceFile).mockResolvedValueOnce({
    exists: true,
    isDir: false,
    size: 1,
    mtimeMs: null,
    isSymlink: true,
    mode: 0o120777,
  })
  await expect(captureBotWorkspace("plugin", handle)).rejects.toThrow("completely")
  jest
    .mocked(statWorkspaceFile)
    .mockResolvedValueOnce({ exists: true, isDir: false, size: 1, mtimeMs: null })
  await expect(captureBotWorkspace("plugin", handle)).rejects.toThrow("completely")
})

async function approved() {
  const handle = await acquireBotWorkspace("plugin", spec, deps)
  const snapshot = await captureBotWorkspace("plugin", handle)
  const input = {
    approvalId: "approval",
    snapshotId: snapshot.id,
    branch: "codex/fix",
    message: "fix: approved change",
  }
  mockApproval.mockResolvedValue({
    runId: "run",
    status: "approved",
    expiresAt: Date.now() + 60_000,
    approvalDetail: { snapshot, publish: { branch: input.branch, message: input.message } },
  })
  return { handle, snapshot, input }
}

it("isolates runs, checks out the requested ref, and replays a durable handle", async () => {
  const handle = await acquireBotWorkspace("plugin", spec, deps)
  expect(await acquireBotWorkspace("plugin", { ...spec }, deps)).toEqual(handle)
  const other = await acquireBotWorkspace("plugin", { ...spec, runId: "other" }, deps)
  expect(other.root).not.toEqual(handle.root)
  expect(deps.clone).toHaveBeenCalledTimes(2)
  expect(deps.checkoutRef).toHaveBeenCalledWith(handle.root, "base")
  await expect(acquireBotWorkspace("plugin", { ...spec, ref: "other" }, deps)).rejects.toThrow(
    "cannot change"
  )
})

it("rejects forged, foreign and inactive run handles", async () => {
  const handle = await acquireBotWorkspace("plugin", spec, deps)
  await expect(assertOwnedBotWorkspace("foreign", handle)).rejects.toThrow("does not belong")
  await expect(assertOwnedBotWorkspace("plugin", { ...handle, root: "/secret" })).rejects.toThrow(
    "does not belong"
  )
  await expect(assertOwnedBotWorkspace("plugin", { ...handle, id: undefined })).rejects.toThrow(
    "run-owned"
  )
  jest.mocked(resolveBotIntegrationBinding).mockRejectedValueOnce(new Error("cancelled"))
  await expect(assertOwnedBotWorkspace("plugin", handle)).rejects.toThrow("cancelled")
})

it("fails closed for invalid refs and unavailable Git transports", async () => {
  await expect(acquireBotWorkspace("plugin", { ...spec, ref: "../secret" }, deps)).rejects.toThrow(
    "Invalid"
  )
  jest.mocked(deps.clone).mockResolvedValue("")
  await expect(acquireBotWorkspace("plugin", spec, deps)).rejects.toThrow("no Git")
})

it("captures immutable exact contents including deletion and preserves capture time on replay", async () => {
  const { handle, snapshot } = await approved()
  expect(snapshot.files[0]).toEqual({
    path: "a.ts",
    oldContent: "before\n",
    newContent: "after\n",
    status: "modified",
    mode: "100755",
  })
  expect(snapshot.diff).toContain("-before")
  expect(snapshot.files[0].newContent).toBe("after\n")
  expect(await captureBotWorkspace("plugin", handle)).toEqual(snapshot)
  jest
    .mocked(statWorkspaceFile)
    .mockResolvedValue({ exists: false, isDir: false, size: 0, mtimeMs: null })
  expect((await captureBotWorkspace("plugin", handle)).files[0].status).toBe("deleted")
})

it("refuses incomplete and binary artifacts", async () => {
  const handle = await acquireBotWorkspace("plugin", spec, deps)
  jest.mocked(statWorkspaceFile).mockResolvedValueOnce({
    exists: true,
    isDir: false,
    size: 8_000_000,
    mtimeMs: 0,
    mode: 0o100755,
    isSymlink: false,
  })
  await expect(captureBotWorkspace("plugin", handle)).rejects.toThrow("completely")
  jest.mocked(readWorkspaceFile).mockResolvedValueOnce("binary\0")
  await expect(captureBotWorkspace("plugin", handle)).rejects.toThrow("Binary")
  jest.mocked(gitReadBlobAtRef).mockResolvedValueOnce(null)
  await expect(captureBotWorkspace("plugin", handle)).rejects.toThrow("Binary")
})

it("requires exact unexpired approval and rejects a changed checkout", async () => {
  const { handle, input } = await approved()
  await expect(
    publishBotWorkspace("plugin", handle, { ...input, message: "different" })
  ).rejects.toThrow("exact artifact")
  jest.mocked(readWorkspaceFile).mockResolvedValue("changed again")
  await expect(publishBotWorkspace("plugin", handle, input)).rejects.toThrow(
    "changed after approval"
  )
  expect(authenticatedIntegrationRequest).not.toHaveBeenCalled()
  mockApproval.mockResolvedValueOnce({ runId: "run", status: "denied" })
  await expect(publishBotWorkspace("plugin", handle, input)).rejects.toThrow("exact artifact")
})

it("rejects a stale target SHA before any GitHub write", async () => {
  const { handle, input } = await approved()
  jest
    .mocked(authenticatedIntegrationRequest)
    .mockResolvedValue({ status: 200, headers: {}, data: { sha: "changed" } })
  await expect(publishBotWorkspace("plugin", handle, input)).rejects.toThrow("Target SHA")
  expect(authenticatedIntegrationRequest).toHaveBeenCalledTimes(1)
})

it("publishes approved files via the bound account and replays without duplicate ref writes", async () => {
  const { handle, input } = await approved()
  jest
    .mocked(authenticatedIntegrationRequest)
    .mockImplementation(async (_plugin, _account, url, init) => {
      let data: unknown = {}
      let status = 200
      if (url.includes("/commits/master"))
        data = { sha: "base", commit: { tree: { sha: "original-tree" } } }
      else if (url.includes("original-tree?"))
        data = { tree: [{ path: "a.ts", mode: "100755", type: "blob" }] }
      else if (url.endsWith("/git/trees")) data = { sha: "new-tree" }
      else if (url.endsWith("/git/commits")) data = { sha: "new-commit" }
      else if (url.includes("/git/ref/heads/")) status = 404
      if (url.endsWith("/git/trees")) expect(JSON.parse(init!.body!).tree[0].mode).toBe("100755")
      return { status, headers: {}, data } as never
    })
  expect(await publishBotWorkspace("plugin", handle, input)).toEqual({
    branch: "codex/fix",
    headSha: "new-commit",
    repository: "org/repo",
    snapshotId: input.snapshotId,
  })
  const count = jest.mocked(authenticatedIntegrationRequest).mock.calls.length
  await publishBotWorkspace("plugin", handle, input)
  expect(authenticatedIntegrationRequest).toHaveBeenCalledTimes(count)
  expect(authenticatedIntegrationRequest).toHaveBeenCalledWith(
    "github-delivery",
    "account",
    expect.any(String),
    expect.anything()
  )
})

it("reconciles a ref written before a crash rather than creating it again", async () => {
  const { handle, input, snapshot } = await approved()
  mockSteps.set(`run:__host:publication-commit:${snapshot.id}`, { sha: "existing-commit" })
  jest.mocked(authenticatedIntegrationRequest).mockImplementation(
    async (_p, _a, url) =>
      ({
        status: 200,
        headers: {},
        data: url.includes("/commits/")
          ? { sha: "base", commit: { tree: { sha: "tree" } } }
          : { object: { sha: "existing-commit" } },
      }) as never
  )
  expect((await publishBotWorkspace("plugin", handle, input)).headSha).toBe("existing-commit")
  expect(
    jest
      .mocked(authenticatedIntegrationRequest)
      .mock.calls.every((call) => !call[3]?.method || call[3].method === "GET")
  ).toBe(true)
})

it("recovers a completed clone allocation after a crash without cloning over it", async () => {
  mockSteps.set("run:__host:workspace-allocation", { id: "allocated", spec })
  deps.remotesOf = jest.fn(async () => [{ name: "origin", url: "https://github.com/org/repo.git" }])
  const handle = await acquireBotWorkspace("plugin", spec, deps)
  expect(handle.id).toBe("allocated")
  expect(deps.clone).not.toHaveBeenCalled()
  expect(deps.removeRepoCache).not.toHaveBeenCalled()
})

it("cleans only a reserved incomplete clone and refuses changed allocation specs", async () => {
  mockSteps.set("run:__host:workspace-allocation", { id: "allocated", spec })
  jest.mocked(deps.headOf!).mockRejectedValueOnce(new Error("partial clone"))
  await acquireBotWorkspace("plugin", spec, deps)
  expect(deps.removeRepoCache).toHaveBeenCalledWith(["bot-runs", "allocated"])
  mockSteps.delete("run:__host:workspace")
  await expect(acquireBotWorkspace("plugin", { ...spec, ref: "other" }, deps)).rejects.toThrow(
    "cannot change"
  )
})

it.each([
  { status: "pending" },
  { status: "denied" },
  { expiresAt: 1 },
  { runId: "foreign" },
  { approvalDetail: {} },
])("rejects invalid approval state %j before network writes", async (patch) => {
  const { handle, snapshot, input } = await approved()
  mockApproval.mockResolvedValue({
    runId: "run",
    status: "approved",
    expiresAt: Date.now() + 60_000,
    approvalDetail: { snapshot, publish: { branch: input.branch, message: input.message } },
    ...patch,
  })
  await expect(publishBotWorkspace("plugin", handle, input)).rejects.toThrow("exact artifact")
  expect(authenticatedIntegrationRequest).not.toHaveBeenCalled()
})

it("rejects invalid branch names, missing snapshot, and expired approval during publication", async () => {
  const { handle, input } = await approved()
  await expect(
    publishBotWorkspace("plugin", handle, { ...input, branch: "master" })
  ).rejects.toThrow("Invalid")
  await expect(publishBotWorkspace("plugin", handle, { ...input, message: " " })).rejects.toThrow(
    "Invalid"
  )
  await expect(
    publishBotWorkspace("plugin", handle, { ...input, snapshotId: "missing" })
  ).rejects.toThrow("exact artifact")
  jest.mocked(authenticatedIntegrationRequest).mockImplementation(async () => {
    mockApproval.mockResolvedValue({ status: "denied", expiresAt: 1 })
    return {
      status: 200,
      headers: {},
      data: { sha: "base", commit: { tree: { sha: "original" } } },
    } as never
  })
  await expect(publishBotWorkspace("plugin", handle, input)).rejects.toThrow("changed or expired")
  expect(authenticatedIntegrationRequest).toHaveBeenCalledTimes(1)
})

it("refuses a credential rebound while GitHub publication is in progress", async () => {
  const { handle, input } = await approved()
  jest.mocked(authenticatedIntegrationRequest).mockImplementation(async () => {
    jest.mocked(resolveBotIntegrationBinding).mockResolvedValue({
      repository: "org/repo",
      account: { pluginId: "github-delivery", id: "other" },
    } as never)
    return {
      status: 200,
      headers: {},
      data: { sha: "base", commit: { tree: { sha: "original" } } },
    } as never
  })
  await expect(publishBotWorkspace("plugin", handle, input)).rejects.toThrow(
    "credential binding changed"
  )
  expect(authenticatedIntegrationRequest).toHaveBeenCalledTimes(1)
})

it("captures additions and renames without treating absent base files as binary", async () => {
  const handle = await acquireBotWorkspace("plugin", spec, deps)
  jest.mocked(gitStatus).mockResolvedValue({
    changes: [{ path: "new.ts", status: "added" }],
    staged: [],
    merge: [],
  } as never)
  jest.mocked(gitReadBlobAtRef).mockResolvedValue(null)
  const snapshot = await captureBotWorkspace("plugin", handle)
  expect(snapshot.files[0].status).toBe("added")
  expect(snapshot.diff).toContain("/dev/null")
  expect(snapshot.files[0].oldContent).toBeNull()
  jest.mocked(gitStatus).mockResolvedValue({
    changes: [{ path: "new.ts", origPath: "old.ts", status: "renamed" }],
    staged: [],
    merge: [],
  } as never)
  expect((await captureBotWorkspace("plugin", handle)).files).toHaveLength(2)
})

it("fetches a fork PR immutable SHA from the bound repository before checkout", async () => {
  const sha = "a".repeat(40)
  deps.fetchRef = jest.fn(async () => {
    expect(deps.checkoutRef).not.toHaveBeenCalled()
  })
  deps.headOf = jest.fn(async () => sha)
  const handle = await acquireBotWorkspace("plugin", { ...spec, ref: sha }, deps)
  expect(deps.fetchRef).toHaveBeenCalledWith(handle.root, sha)
  expect(deps.clone).toHaveBeenCalledWith("https://github.com/org/repo.git", handle.root, {
    allowedHosts: ["github.com"],
  })
  expect(handle.headRef).toBe(sha)
  mockSteps.clear()
  deps.fetchRef = undefined
  await expect(acquireBotWorkspace("plugin", { ...spec, ref: sha }, deps)).rejects.toThrow(
    "cannot fetch"
  )
  mockSteps.clear()
  deps.fetchRef = jest.fn()
  deps.headOf = jest.fn(async () => "wrong")
  await expect(acquireBotWorkspace("plugin", { ...spec, ref: sha }, deps)).rejects.toThrow(
    "immutable revision"
  )
})

it("revalidates automatic publication authority before writes and on completed-publication replay", async () => {
  const { handle, snapshot, input } = await approved()
  jest.mocked(assertBotPublicationAuthority).mockRejectedValueOnce(new Error("policy revoked"))
  await expect(publishBotWorkspace("plugin", handle, input)).rejects.toThrow("policy revoked")
  expect(authenticatedIntegrationRequest).not.toHaveBeenCalled()
  mockSteps.set(`run:__host:publication:${snapshot.id}`, {
    branch: input.branch,
    headSha: "published",
  })
  jest.mocked(assertBotPublicationAuthority).mockRejectedValueOnce(new Error("policy revoked"))
  await expect(publishBotWorkspace("plugin", handle, input)).rejects.toThrow("policy revoked")
})

it("stops publication if host policy is downgraded after preparing the artifact", async () => {
  const { handle, input } = await approved()
  jest
    .mocked(assertBotPublicationAuthority)
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("grant narrowed"))
  await expect(publishBotWorkspace("plugin", handle, input)).rejects.toThrow("grant narrowed")
  expect(authenticatedIntegrationRequest).not.toHaveBeenCalled()
})
