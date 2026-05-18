/**
 * git-repo importer — walks recent commits in a local Git repository via the
 * Tauri `twin_parse_git_repo` command and emits one `RawSource` per commit.
 *
 * The walk runs in the Rust main process (libgit2 via the `git2` crate), so
 * this module no longer pulls `simple-git` into the Next.js bundle — that's
 * what let us drop the `NODE_ONLY_MODULES` / `SERVER_ONLY_PACKAGES` aliases
 * from `next.config.ts`. The UI continues to gate the picker behind
 * `tauriAvailable`; the `isTauri()` early-return below is a defensive belt
 * for non-Tauri callers (jsdom, web preview, etc.).
 */

import { invoke } from "@tauri-apps/api/core"

import { isTauri } from "@/lib/tauri"
import type { RawSource } from "@/lib/twin/ingest/parse"

export interface GitRepoImportOptions {
  twinId: string
  /** Filesystem path to the repo root. */
  repoPath: string
  /** Maximum commits to walk back, newest first. Defaults to 200. */
  maxCommits?: number
  /** Author filter (string contains, case-insensitive). */
  author?: string
}

export interface CommitRecord {
  hash: string
  subject: string
  body: string
  author: string
  email: string
  timestampMs: number
  filesChanged: number
  insertions: number
  deletions: number
  /** `--stat` summary + unified patch, capped at 8 KB by the Rust command. */
  diff: string
}

interface ParseGitRepoArgs {
  repoPath: string
  maxCommits: number
  author?: string
}

const DEFAULT_MAX_COMMITS = 200

export async function parseGitRepo(options: GitRepoImportOptions): Promise<RawSource[]> {
  if (!isTauri()) {
    return []
  }

  const args: ParseGitRepoArgs = {
    repoPath: options.repoPath,
    maxCommits:
      options.maxCommits && options.maxCommits > 0 ? options.maxCommits : DEFAULT_MAX_COMMITS,
    author: options.author?.trim() || undefined,
  }

  let records: CommitRecord[]
  try {
    records = await invoke<CommitRecord[]>("twin_parse_git_repo", { args })
  } catch {
    // The Rust command surfaces its own errors as strings; we mirror the
    // legacy behavior of returning zero sources so the workbench can carry
    // on with whatever else the user selected.
    return []
  }

  return records.map((record) => recordToRawSource(options, record))
}

function recordToRawSource(options: GitRepoImportOptions, record: CommitRecord): RawSource {
  return {
    id: `tws_git_${options.twinId}_${record.hash.slice(0, 12)}`,
    filename: `${options.repoPath}/${record.hash.slice(0, 12)}.md`,
    format: "code",
    text: renderCommit(record),
    baseMetadata: {
      commitSha: record.hash,
      timestamp: record.timestampMs,
      speakers: [`${record.author} <${record.email}>`],
    },
  }
}

function renderCommit(commit: CommitRecord): string {
  return [
    `# ${commit.subject}`,
    "",
    `**Commit:** ${commit.hash}`,
    `**Author:** ${commit.author} <${commit.email}>`,
    commit.timestampMs ? `**Date:** ${new Date(commit.timestampMs).toISOString()}` : null,
    "",
    commit.body || "(no body)",
    "",
    "## Diff",
    "",
    "```diff",
    commit.diff,
    "```",
  ]
    .filter((line): line is string => line !== null)
    .join("\n")
}
