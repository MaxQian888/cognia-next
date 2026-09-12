/** Isolated Bot checkouts and immutable publication artifacts, using existing host services. */
import type { PluginWorkspaceHandle, AcquireDeps } from "./acquire"
import { getBotRunStep, completeBotRunStep } from "@/lib/db/bot-run-steps"
import {
  resolveBotIntegrationBinding,
  canonicalIntegrationValue,
} from "../api/bot-integration-binding"
import { getDb } from "@/lib/db/schema"
import { gitDiffRefsFiles, gitStatus, gitReadBlobAtRef, gitLog } from "@/lib/git/commands"
import { readWorkspaceFile, statWorkspaceFile } from "@/lib/files/workspace-fs"
import { authenticatedIntegrationRequest } from "@/lib/integrations/action-runner"
import { isRemoteHostActive } from "@/lib/tauri/transport-routing"
import { updateBotInstallation } from "@/lib/db/bot-installations"

export interface BotRunWorkspaceSpec {
  kind: "bot-run"
  runId: string
  repository: string
  ref: string
  /** Moving branch whose SHA must still match the acquired commit before publishing. */
  targetRef?: string
  credentialSlot: string
}
export interface BotWorkspaceFile {
  path: string
  oldContent: string | null
  newContent: string | null
  status: "added" | "modified" | "deleted"
  mode: "100644" | "100755"
}
export interface BotWorkspaceSnapshot {
  id: string
  runId: string
  baseSha: string
  headSha: string
  diff: string
  files: BotWorkspaceFile[]
  capturedAt: number
}
export interface BotWorkspacePublishInput {
  approvalId: string
  snapshotId: string
  message: string
  branch: string
}
interface OwnedWorkspace {
  pluginId: string
  spec: BotRunWorkspaceSpec
  handle: PluginWorkspaceHandle
}
const WORKSPACE_STEP = "__host:workspace"

export async function assertOwnedBotWorkspace(pluginId: string, handle: PluginWorkspaceHandle) {
  if (!handle.id || !handle.runId || handle.origin !== "bot-run")
    throw new Error("A run-owned workspace is required")
  const row = await getBotRunStep(handle.runId, WORKSPACE_STEP)
  const owned = row?.output as OwnedWorkspace | undefined
  if (
    !owned ||
    owned.pluginId !== pluginId ||
    canonicalIntegrationValue(owned.handle) !== canonicalIntegrationValue(handle)
  ) {
    throw new Error("Workspace handle does not belong to this plugin and run")
  }
  const binding = await resolveBotIntegrationBinding(
    pluginId,
    { runId: handle.runId, slotId: owned.spec.credentialSlot },
    owned.spec.repository
  )
  return { ...owned, binding }
}

export async function acquireBotWorkspace(
  pluginId: string,
  spec: BotRunWorkspaceSpec,
  deps: AcquireDeps
): Promise<PluginWorkspaceHandle> {
  if (!spec.ref || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(spec.ref) || spec.ref.includes(".."))
    throw new Error("Invalid checkout ref")
  const binding = await resolveBotIntegrationBinding(
    pluginId,
    { runId: spec.runId, slotId: spec.credentialSlot },
    spec.repository
  )
  if (isRemoteHostActive()) {
    const reason =
      "Isolated Bot workspaces must be acquired by their Desktop or Headless execution host; paired clients provide monitoring and approvals."
    await updateBotInstallation(binding.installation.id, {
      status: "needs_setup",
      monitor: { ...binding.installation.monitor, lastError: reason },
    })
    throw new Error(reason)
  }
  const saved = (await getBotRunStep(spec.runId, WORKSPACE_STEP))?.output as
    OwnedWorkspace | undefined
  if (saved) {
    if (canonicalIntegrationValue(saved.spec) !== canonicalIntegrationValue(spec))
      throw new Error("A run cannot change its workspace acquisition")
    await assertOwnedBotWorkspace(pluginId, saved.handle)
    return saved.handle
  }
  // The host cache transport validates every segment. A run never writes a shared repository cache.
  const allocationStep = "__host:workspace-allocation"
  const allocation = (await getBotRunStep(spec.runId, allocationStep))?.output as
    { id: string; spec: BotRunWorkspaceSpec } | undefined
  if (allocation && canonicalIntegrationValue(allocation.spec) !== canonicalIntegrationValue(spec))
    throw new Error("A run cannot change its workspace acquisition")
  const id = allocation?.id ?? crypto.randomUUID()
  await completeBotRunStep(spec.runId, allocationStep, { id, spec })
  const segments = ["bot-runs", id]
  const destination = await deps.repoCacheDir(segments)
  const runtimeStateRoot = await deps.repoCacheDir(["bot-runs", `${id}-state`])
  const repository = binding.repository
  const url = `https://github.com/${repository}.git`
  const cachedHead =
    allocation && deps.headOf ? await deps.headOf(destination).catch(() => null) : null
  const remotes = cachedHead && deps.remotesOf ? await deps.remotesOf(destination) : []
  const reusable = Boolean(cachedHead && remotes.some((remote) => remote.url === url))
  if (allocation && !reusable) await deps.removeRepoCache(segments)
  const root = reusable
    ? destination
    : await deps.clone(url, destination, { allowedHosts: ["github.com"] })
  if (!root) throw new Error("This host has no Git workspace transport")
  if (!deps.checkoutRef || !deps.headOf)
    throw new Error("This host cannot resolve isolated checkout revisions")
  // Fork PR objects may exist only behind refs/pull in the configured repository.
  if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(spec.ref)) {
    if (!deps.fetchRef) throw new Error("This host cannot fetch an exact isolated revision")
    await deps.fetchRef(root, spec.ref)
  }
  await deps.checkoutRef(root, spec.ref)
  const headRef = await deps.headOf(root)
  if (!headRef) throw new Error("Checkout did not resolve a commit")
  if (
    /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(spec.ref) &&
    headRef.toLowerCase() !== spec.ref.toLowerCase()
  )
    throw new Error("Checkout did not resolve the requested immutable revision")
  const [owner, repo] = repository.split("/")
  const handle: PluginWorkspaceHandle = {
    id,
    runId: spec.runId,
    root,
    origin: "bot-run",
    runtimeStateRoot,
    ephemeral: true,
    headRef,
    remote: { host: "github.com", owner, repo, url, ref: spec.ref },
  }
  await completeBotRunStep(spec.runId, WORKSPACE_STEP, {
    pluginId,
    spec,
    handle,
  } satisfies OwnedWorkspace)
  return handle
}

export async function digestBotArtifact(value: unknown): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify(value))
  const digest = await crypto.subtle.digest("SHA-256", data)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function describeDiff(file: BotWorkspaceFile): string {
  const before = file.oldContent?.split("\n") ?? []
  const after = file.newContent?.split("\n") ?? []
  return [
    `--- ${file.oldContent === null ? "/dev/null" : `a/${file.path}`}`,
    `+++ ${file.newContent === null ? "/dev/null" : `b/${file.path}`}`,
    `@@ -1,${before.length} +1,${after.length} @@`,
    ...before.map((line) => `-${line}`),
    ...after.map((line) => `+${line}`),
  ].join("\n")
}

export async function captureBotWorkspace(
  pluginId: string,
  handle: PluginWorkspaceHandle
): Promise<BotWorkspaceSnapshot> {
  await assertOwnedBotWorkspace(pluginId, handle)
  const baseSha = handle.headRef!
  const [status, committed, [head]] = await Promise.all([
    gitStatus(handle.root),
    gitDiffRefsFiles(handle.root, baseSha, "HEAD"),
    gitLog(handle.root, 1, 0),
  ])
  if (!head?.hash || status.merge.length)
    throw new Error("Workspace has no resolved HEAD or has unresolved conflicts")
  const changes = [...committed, ...status.staged, ...status.changes]
  const paths = Array.from(
    new Set(changes.flatMap((file) => (file.origPath ? [file.origPath, file.path] : [file.path])))
  ).sort()
  const files: BotWorkspaceFile[] = []
  for (const path of paths) {
    const oldContent = await gitReadBlobAtRef(handle.root, baseSha, path)
    const change = changes.find((file) => file.path === path || file.origPath === path)
    if (
      change?.status === "typeChanged" ||
      (oldContent === null && change && !["added", "untracked", "renamed"].includes(change.status))
    )
      throw new Error(`Binary or special file cannot be captured completely: ${path}`)
    const stat = await statWorkspaceFile(handle.root, path)
    if (
      stat.exists &&
      (stat.isDir ||
        stat.isSymlink ||
        stat.mode === undefined ||
        (stat.mode & 0o170000) !== 0o100000 ||
        stat.size > 4 * 1024 * 1024)
    )
      throw new Error(`Publication file cannot be captured completely: ${path}`)
    const newContent = stat.exists
      ? await readWorkspaceFile(handle.root, path, 4 * 1024 * 1024)
      : null
    const mode = stat.exists && (stat.mode! & 0o111) !== 0 ? "100755" : "100644"
    if (oldContent === newContent && !change) continue
    if (oldContent?.includes("\0") || newContent?.includes("\0"))
      throw new Error(`Binary publication requires manual handling: ${path}`)
    files.push({
      path,
      oldContent,
      newContent,
      status: oldContent === null ? "added" : newContent === null ? "deleted" : "modified",
      mode,
    })
  }
  const artifact = { runId: handle.runId!, baseSha, headSha: head.hash, files }
  const snapshot: BotWorkspaceSnapshot = {
    ...artifact,
    id: await digestBotArtifact(artifact),
    diff: files.map(describeDiff).join("\n"),
    capturedAt: Date.now(),
  }
  const existing = await getBotRunStep(handle.runId!, `__host:snapshot:${snapshot.id}`)
  if (existing?.status === "completed") return existing.output as BotWorkspaceSnapshot
  await completeBotRunStep(handle.runId!, `__host:snapshot:${snapshot.id}`, snapshot)
  return snapshot
}

export async function publishBotWorkspace(
  pluginId: string,
  handle: PluginWorkspaceHandle,
  input: BotWorkspacePublishInput
): Promise<{ branch: string; headSha: string }> {
  const owned = await assertOwnedBotWorkspace(pluginId, handle)
  if (
    !/^codex\/[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(input.branch) ||
    input.branch.includes("..") ||
    !input.message.trim()
  )
    throw new Error("Invalid publication branch or message")
  const snapshot = (await getBotRunStep(handle.runId!, `__host:snapshot:${input.snapshotId}`))
    ?.output as BotWorkspaceSnapshot | undefined
  const approval = await getDb().executionRunInterrupts.get(input.approvalId)
  const detail = approval?.approvalDetail
  if (
    !snapshot ||
    !approval ||
    approval.runId !== handle.runId ||
    approval.status !== "approved" ||
    !approval.expiresAt ||
    approval.expiresAt <= Date.now() ||
    canonicalIntegrationValue(detail?.snapshot) !== canonicalIntegrationValue(snapshot) ||
    canonicalIntegrationValue(detail?.publish) !==
      canonicalIntegrationValue({ branch: input.branch, message: input.message })
  )
    throw new Error("Publication requires approval of this exact artifact and intent")
  const previous = await getBotRunStep(handle.runId!, `__host:publication:${snapshot.id}`)
  if (previous?.status === "completed")
    return previous.output as { branch: string; headSha: string }
  const current = await captureBotWorkspace(pluginId, handle)
  if (current.id !== snapshot.id) throw new Error("Workspace changed after approval")
  const prefix = `https://api.github.com/repos/${owned.binding.repository}`
  const revalidate = async () => {
    const fresh = await assertOwnedBotWorkspace(pluginId, handle)
    if (
      fresh.binding.account.id !== owned.binding.account.id ||
      fresh.binding.account.providerId !== owned.binding.account.providerId
    )
      throw new Error("Publication credential binding changed")
    const currentApproval = await getDb().executionRunInterrupts.get(input.approvalId)
    if (
      currentApproval?.status !== "approved" ||
      currentApproval.expiresAt <= Date.now() ||
      canonicalIntegrationValue(currentApproval.approvalDetail) !==
        canonicalIntegrationValue(detail)
    )
      throw new Error("Publication approval changed or expired")
  }
  const request = async <T>(path: string, method = "GET", body?: unknown): Promise<T> => {
    await revalidate()
    const response = await authenticatedIntegrationRequest<T>(
      owned.binding.account.pluginId,
      owned.binding.account.id,
      `${prefix}${path}`,
      { method, ...(body ? { body: JSON.stringify(body) } : {}) }
    )
    if (response.status < 200 || response.status >= 300)
      throw new Error(`GitHub publication failed (${response.status})`)
    return response.data
  }
  const target = await request<{ sha: string; commit: { tree: { sha: string } } }>(
    `/commits/${encodeURIComponent(owned.spec.targetRef ?? owned.spec.ref)}`
  )
  if (target.sha !== snapshot.baseSha) throw new Error("Target SHA changed after approval")
  // All Git objects are immutable. Save the commit identity before ref publication; a retry queries the ref first.
  const commitStep = `__host:publication-commit:${snapshot.id}`
  let commit = (await getBotRunStep(handle.runId!, commitStep))?.output as
    { sha: string } | undefined
  if (!commit) {
    const originalTree = await request<{
      tree: Array<{ path: string; mode: string; type: string }>
      truncated?: boolean
    }>(`/git/trees/${target.commit.tree.sha}?recursive=1`)
    if (originalTree.truncated)
      throw new Error("GitHub tree is truncated; publication cannot preserve file modes")
    const treeEntries = snapshot.files.map((file) => {
      const original = originalTree.tree.find((entry) => entry.path === file.path)
      if (original && !["100644", "100755"].includes(original.mode))
        throw new Error(`Publication requires manual handling of ${file.path}`)
      return {
        path: file.path,
        mode: file.mode,
        type: "blob",
        ...(file.newContent === null ? { sha: null } : { content: file.newContent }),
      }
    })
    const tree = await request<{ sha: string }>("/git/trees", "POST", {
      base_tree: target.commit.tree.sha,
      tree: treeEntries,
    })
    commit = await request<{ sha: string }>("/git/commits", "POST", {
      message: input.message,
      tree: tree.sha,
      parents: [snapshot.baseSha],
    })
    await completeBotRunStep(handle.runId!, commitStep, commit)
  }
  const refPath = `/git/ref/heads/${input.branch.split("/").map(encodeURIComponent).join("/")}`
  const latestTarget = await request<{ sha: string }>(
    `/commits/${encodeURIComponent(owned.spec.targetRef ?? owned.spec.ref)}`
  )
  if (latestTarget.sha !== snapshot.baseSha)
    throw new Error("Target SHA changed during publication")
  await revalidate()
  const remote = await authenticatedIntegrationRequest<{ object?: { sha: string } }>(
    owned.binding.account.pluginId,
    owned.binding.account.id,
    `${prefix}${refPath}`
  )
  if (remote.status === 404)
    await request("/git/refs", "POST", { ref: `refs/heads/${input.branch}`, sha: commit.sha })
  else if (remote.status !== 200 || remote.data.object?.sha !== commit.sha)
    throw new Error("Publication branch already exists with different content")
  const result = {
    branch: input.branch,
    headSha: commit.sha,
    repository: owned.binding.repository,
    snapshotId: snapshot.id,
  }
  await completeBotRunStep(handle.runId!, `__host:publication:${snapshot.id}`, result)
  return result
}
