/**
 * GitHub backup destination — commits encrypted snapshots to a PRIVATE
 * repository through the contents API (spec 2026-08-16, D).
 *
 * Layout under `<path>/` (mirrors the WebDAV destination):
 *   cognia-backup-<iso>.enc.cbk — immutable timestamped history
 *   latest.enc.cbk              — overwritten each run (O(1) restore pointer)
 *
 * Guardrails:
 *   - the repository MUST be private; visibility is checked before every
 *     upload (a repo flipped public later stops receiving snapshots);
 *   - retention prunes timestamped copies down to `retainCount`
 *     (`backupAutoSchedule.retainCount`, shared with local/WebDAV);
 *   - the token never leaves the keyring / auth-session store; every request
 *     goes through the host-neutral HTTP helper (desktop reqwest / Node fetch).
 *
 * The contents API is used directly (no git tree building) — snapshots are a
 * few MB at most and one file per run keeps the history linear.
 */

import { getSettings } from "@/lib/db/settings"
import { loggers } from "@cognia/logging"
import {
  getBackupDestinationsSettings,
  getGithubBackupToken,
  resolveGithubBackupConfig,
  updateBackupDestinationsSettings,
  type ResolvedGithubBackupConfig,
} from "./config"
import { backupHttpRequest, parseJsonBody, toBase64Utf8, type BackupHttpFn } from "./http"
import { webdavSnapshotName, type SnapshotMeta } from "./webdav"

const log = loggers.export
const API_BASE = "https://api.github.com"
const LATEST_POINTER = "latest.enc.cbk"
const SNAPSHOT_RE = /^cognia-backup-.*\.enc\.cbk$/
const DEFAULT_RETAIN = 5

export type GithubUploadResult =
  | { ok: true; remotePath: string; commitSha?: string }
  | { ok: false; error: string; code?: "not-configured" | "no-token" | "public-repo" | "http" }

export interface GithubDestinationDeps {
  http?: BackupHttpFn
  now?: () => number
  /** Skip the settings read; used by "verify" from the settings card. */
  config?: ResolvedGithubBackupConfig
  token?: string
}

interface RepoInfo {
  private: boolean
  default_branch: string
  full_name: string
}

interface ContentEntry {
  name: string
  path: string
  sha: string
  type: string
}

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "cognia-backup/1.0",
    "Content-Type": "application/json",
  }
}

async function resolveRetainCount(): Promise<number> {
  try {
    const settings = await getSettings()
    const n = settings.backupAutoSchedule?.retainCount
    return typeof n === "number" && n > 0 ? n : DEFAULT_RETAIN
  } catch {
    return DEFAULT_RETAIN
  }
}

/** GET /repos/{owner}/{repo} — visibility + default branch. */
export async function fetchGithubRepoInfo(
  config: ResolvedGithubBackupConfig,
  token: string,
  http: BackupHttpFn = backupHttpRequest
): Promise<{ ok: true; info: RepoInfo } | { ok: false; error: string; status: number }> {
  const response = await http({
    url: `${API_BASE}/repos/${config.owner}/${config.repo}`,
    method: "GET",
    headers: headers(token),
  })
  if (response.status !== 200) {
    const parsed = parseJsonBody<{ message?: string }>(response.body)
    return {
      ok: false,
      status: response.status,
      error: parsed?.message ?? `GitHub returned HTTP ${response.status}`,
    }
  }
  const info = parseJsonBody<RepoInfo>(response.body)
  if (!info || typeof info.private !== "boolean") {
    return { ok: false, status: response.status, error: "Unexpected repository response" }
  }
  return { ok: true, info }
}

/**
 * Verify a configuration from the settings card: token works, repo exists and
 * is private. Records the verified visibility on the settings row.
 */
export async function verifyGithubBackupDestination(
  deps: GithubDestinationDeps = {}
): Promise<{ ok: true; defaultBranch: string } | { ok: false; error: string; code: string }> {
  const settings = await getBackupDestinationsSettings()
  const config =
    deps.config ?? resolveGithubBackupConfig(settings.github, { requireEnabled: false })
  if (!config)
    return { ok: false, error: "GitHub backup is not configured.", code: "not-configured" }
  const token = deps.token ?? (await getGithubBackupToken(config.credential))
  if (!token) return { ok: false, error: "No GitHub token is available.", code: "no-token" }
  const info = await fetchGithubRepoInfo(config, token, deps.http)
  if (!info.ok) return { ok: false, error: info.error, code: "http" }
  const visibility = info.info.private ? "private" : "public"
  await updateBackupDestinationsSettings((current) => ({
    ...current,
    github: current.github
      ? { ...current.github, lastVerifiedVisibility: visibility }
      : current.github,
  })).catch(() => undefined)
  if (!info.info.private) {
    return {
      ok: false,
      code: "public-repo",
      error: `Repository ${config.repoFullName} is public; backups are only written to private repositories.`,
    }
  }
  return { ok: true, defaultBranch: info.info.default_branch }
}

async function getExistingSha(
  config: ResolvedGithubBackupConfig,
  token: string,
  http: BackupHttpFn,
  filePath: string,
  branch: string
): Promise<string | undefined> {
  const response = await http({
    url: `${API_BASE}/repos/${config.owner}/${config.repo}/contents/${encodePath(filePath)}?ref=${encodeURIComponent(branch)}`,
    method: "GET",
    headers: headers(token),
  })
  if (response.status !== 200) return undefined
  const entry = parseJsonBody<ContentEntry>(response.body)
  return entry?.sha
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/")
}

async function putFile(
  config: ResolvedGithubBackupConfig,
  token: string,
  http: BackupHttpFn,
  filePath: string,
  branch: string,
  content: string,
  message: string
): Promise<{ ok: true; commitSha?: string } | { ok: false; error: string }> {
  const sha = await getExistingSha(config, token, http, filePath, branch)
  const response = await http({
    url: `${API_BASE}/repos/${config.owner}/${config.repo}/contents/${encodePath(filePath)}`,
    method: "PUT",
    headers: headers(token),
    body: JSON.stringify({
      message,
      content: toBase64Utf8(content),
      branch,
      ...(sha ? { sha } : {}),
    }),
  })
  if (response.status !== 200 && response.status !== 201) {
    const parsed = parseJsonBody<{ message?: string }>(response.body)
    return { ok: false, error: parsed?.message ?? `GitHub returned HTTP ${response.status}` }
  }
  const parsed = parseJsonBody<{ commit?: { sha?: string } }>(response.body)
  return { ok: true, commitSha: parsed?.commit?.sha }
}

async function pruneSnapshots(
  config: ResolvedGithubBackupConfig,
  token: string,
  http: BackupHttpFn,
  branch: string
): Promise<void> {
  const retain = await resolveRetainCount()
  try {
    const response = await http({
      url: `${API_BASE}/repos/${config.owner}/${config.repo}/contents/${encodePath(config.path)}?ref=${encodeURIComponent(branch)}`,
      method: "GET",
      headers: headers(token),
    })
    if (response.status !== 200) return
    const entries = parseJsonBody<ContentEntry[]>(response.body)
    if (!Array.isArray(entries)) return
    const snapshots = entries
      .filter((e) => e.type === "file" && e.name !== LATEST_POINTER && SNAPSHOT_RE.test(e.name))
      // ISO stamps sort chronologically; newest first.
      .sort((a, b) => (a.name < b.name ? 1 : -1))
    for (const stale of snapshots.slice(retain)) {
      try {
        await http({
          url: `${API_BASE}/repos/${config.owner}/${config.repo}/contents/${encodePath(stale.path)}`,
          method: "DELETE",
          headers: headers(token),
          body: JSON.stringify({
            message: `chore(backup): prune ${stale.name}`,
            sha: stale.sha,
            branch,
          }),
        })
      } catch {
        // Best-effort; a failed prune doesn't fail the upload.
      }
    }
  } catch {
    // Listing failed — non-fatal, the snapshot is already uploaded.
  }
}

/** Upload one encrypted envelope: timestamped snapshot + latest pointer + prune. */
export async function uploadSnapshotToGithub(
  envelopeJson: string,
  meta: SnapshotMeta,
  deps: GithubDestinationDeps = {}
): Promise<GithubUploadResult> {
  const http = deps.http ?? backupHttpRequest
  const settings = await getBackupDestinationsSettings()
  const config = deps.config ?? resolveGithubBackupConfig(settings.github)
  if (!config)
    return { ok: false, code: "not-configured", error: "GitHub backup is not configured." }
  const token = deps.token ?? (await getGithubBackupToken(config.credential))
  if (!token) return { ok: false, code: "no-token", error: "No GitHub token is available." }

  try {
    const info = await fetchGithubRepoInfo(config, token, http)
    if (!info.ok) return { ok: false, code: "http", error: info.error }
    if (!info.info.private) {
      return {
        ok: false,
        code: "public-repo",
        error: `Repository ${config.repoFullName} is public; refusing to upload a backup.`,
      }
    }
    const branch = config.branch ?? info.info.default_branch
    const snapshotName = webdavSnapshotName(meta.exportedAt)
    const snapshotPath = `${config.path}/${snapshotName}`
    const stamp = new Date(deps.now?.() ?? Date.now()).toISOString()

    const snapshot = await putFile(
      config,
      token,
      http,
      snapshotPath,
      branch,
      envelopeJson,
      `chore(backup): snapshot ${snapshotName} (${stamp})`
    )
    if (!snapshot.ok) return { ok: false, code: "http", error: snapshot.error }
    const latest = await putFile(
      config,
      token,
      http,
      `${config.path}/${LATEST_POINTER}`,
      branch,
      envelopeJson,
      `chore(backup): update latest pointer (${stamp})`
    )
    if (!latest.ok) return { ok: false, code: "http", error: latest.error }

    await pruneSnapshots(config, token, http, branch)
    await updateBackupDestinationsSettings((current) => ({
      ...current,
      github: current.github
        ? { ...current.github, lastSyncAt: stamp, lastVerifiedVisibility: "private" }
        : current.github,
    })).catch(() => undefined)
    return {
      ok: true,
      remotePath: `${config.repoFullName}:${snapshotPath}`,
      commitSha: snapshot.commitSha,
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    log.error("github_upload_failed", undefined, { error })
    return { ok: false, code: "http", error }
  }
}
