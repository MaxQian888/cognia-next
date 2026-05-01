/**
 * git-repo importer — walks recent commits in a local Git repository and
 * emits one `RawSource` per commit (subject + body + diff stat). The
 * downstream code-strategy chunker handles syntax-aware slicing on the
 * patches; everything before the patch reads as plain markdown.
 *
 * Tauri-only: `simple-git` shells out, so the workbench should gate this
 * importer behind `isTauri()`. The function returns an empty array (with a
 * console warning) when called in a context without `Node.fs` access so
 * tests / web-mode previews fail cleanly.
 */

import type { RawSource } from "../../ingest/parse"

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
  /** Truncated diff (8 KB cap to keep the chunker happy). */
  diff: string
}

const DIFF_BYTE_CAP = 8 * 1024

export async function parseGitRepo(options: GitRepoImportOptions): Promise<RawSource[]> {
  let simpleGitMod: typeof import("simple-git")
  try {
    simpleGitMod = await import("simple-git")
  } catch {
    // simple-git may not load in jsdom / browser previews. Surface zero
    // sources rather than crashing the workbench.
    return []
  }
  const git = simpleGitMod.simpleGit(options.repoPath)
  const limit = options.maxCommits ?? 200

  let log
  try {
    log = await git.log({ maxCount: limit })
  } catch {
    return []
  }

  const sources: RawSource[] = []
  for (const entry of log.all) {
    if (
      options.author &&
      !`${entry.author_name} ${entry.author_email}`
        .toLowerCase()
        .includes(options.author.toLowerCase())
    ) {
      continue
    }

    let diff = ""
    try {
      diff = await git.show(["--stat", "--patch", "--unified=2", entry.hash])
    } catch {
      diff = "(diff unavailable)"
    }
    const truncated =
      diff.length > DIFF_BYTE_CAP ? `${diff.slice(0, DIFF_BYTE_CAP)}\n…(diff truncated)` : diff
    const subject = entry.message.split("\n", 1)[0] ?? entry.message
    const bodyRest = entry.message.slice(subject.length).trim()
    const ts = Date.parse(entry.date)
    const record: CommitRecord = {
      hash: entry.hash,
      subject,
      body: bodyRest,
      author: entry.author_name,
      email: entry.author_email,
      timestampMs: Number.isFinite(ts) ? ts : 0,
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
      diff: truncated,
    }

    const text = renderCommit(record)
    sources.push({
      id: `tws_git_${options.twinId}_${entry.hash.slice(0, 12)}`,
      filename: `${options.repoPath}/${entry.hash.slice(0, 12)}.md`,
      format: "code",
      text,
      baseMetadata: {
        commitSha: entry.hash,
        timestamp: record.timestampMs,
        speakers: [`${record.author} <${record.email}>`],
      },
    })
  }
  return sources
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
