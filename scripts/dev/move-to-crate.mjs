#!/usr/bin/env node
/**
 * Move Rust modules out of `src-tauri` into a crate, under the shared-tree
 * rules (ADR-0196, CLAUDE.md rule 8).
 *
 *   node scripts/dev/move-to-crate.mjs --from src-tauri/src/companion_api \
 *     --to crates/cognia-companion-bus/src [--touch <file>]... \
 *     [--paths-out <file>] [--dry-run] <file>...
 *
 * Each `<file>` is relative to `--from` (`push.rs`, `signaling/peer.rs`) and
 * lands at the same relative path under `--to`. `--touch` names a file the
 * step will also edit in place (the facade `mod.rs`, a manifest).
 *
 * Preflight is all or nothing, because half a move is worse than none:
 *
 * - every source and every touched file is tracked and has no uncommitted
 *   change, staged or not. Another session's edit defers the whole step;
 * - no target exists yet;
 * - commits from the last six hours that touch those files are listed as a
 *   warning. Someone may be mid-way through a series there.
 *
 * The move is a plain rename, never `git mv`: `git mv` stages the rename in
 * the shared index, where another session's `git commit` would sweep it into
 * their commit. Git detects the rename when the step is committed from a
 * private index.
 *
 * The own-path list (every source, target and touched file) is printed, and
 * written to `--paths-out`, for that commit.
 */
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, realpathSync, renameSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, posix, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const RECENT_WINDOW = "6.hours"

/**
 * @param {string[]} argv
 * @returns {{ from: string, to: string, touch: string[], files: string[], dryRun: boolean, pathsOut: string | null }}
 */
export function parseArgs(argv) {
  const options = { from: "", to: "", touch: [], files: [], dryRun: false, pathsOut: null }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = () => {
      const next = argv[index + 1]
      if (next === undefined || next.startsWith("--")) throw new Error(`${arg} needs a value`)
      index += 1
      return next
    }
    if (arg === "--from") options.from = value()
    else if (arg === "--to") options.to = value()
    else if (arg === "--touch") options.touch.push(value())
    else if (arg === "--paths-out") options.pathsOut = value()
    else if (arg === "--dry-run") options.dryRun = true
    else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`)
    else options.files.push(arg)
  }
  if (!options.from || !options.to) throw new Error("--from and --to are required")
  if (options.files.length === 0) throw new Error("name at least one file to move")
  return options
}

/**
 * Pair each file with its repo-relative source and target.
 *
 * @param {{ from: string, to: string, files: string[] }} options
 * @returns {{ source: string, target: string }[]}
 */
export function planMoves({ from, to, files }) {
  const seen = new Set()
  return files.map((file) => {
    const relative = posix.normalize(file.replaceAll("\\", "/"))
    if (isAbsolute(file) || relative.startsWith("../") || relative === "..") {
      throw new Error(`${file}: must be a path inside --from`)
    }
    if (seen.has(relative)) throw new Error(`${file}: named twice`)
    seen.add(relative)
    return { source: posix.join(from, relative), target: posix.join(to, relative) }
  })
}

/**
 * @param {{ source: string, target: string }[]} plan
 * @param {string[]} touch
 * @param {{
 *   untracked: (paths: string[]) => string[],
 *   dirty: (paths: string[]) => string[],
 *   exists: (path: string) => boolean,
 *   recentCommits: (paths: string[]) => string[],
 * }} repo
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function preflight(plan, touch, repo) {
  const inPlace = [...plan.map((move) => move.source), ...touch]
  const errors = []
  for (const path of repo.untracked(inPlace)) errors.push(`${path}: not tracked by git`)
  for (const path of repo.dirty(inPlace)) {
    errors.push(`${path}: has uncommitted changes — defer the step until it is clean`)
  }
  for (const { target } of plan) {
    if (repo.exists(target)) errors.push(`${target}: already exists`)
  }
  const warnings = repo
    .recentCommits(inPlace)
    .map((commit) => `touched in the last ${RECENT_WINDOW.replace(".", " ")}: ${commit}`)
  return { errors, warnings }
}

/** Every path the step owns, sorted, for the commit's pathspec. */
export function ownPaths(plan, touch) {
  return [...new Set([...plan.flatMap((move) => [move.source, move.target]), ...touch])].sort()
}

/** The git-backed `repo` for {@link preflight}, run in `cwd`. */
export function gitRepo(cwd) {
  const git = (args) => execFileSync("git", args, { cwd, encoding: "utf8" })
  return {
    untracked(paths) {
      const tracked = new Set(
        git(["ls-files", "--", ...paths])
          .split("\n")
          .filter(Boolean)
      )
      return paths.filter((path) => !tracked.has(path))
    },
    dirty(paths) {
      // `--no-renames` keeps each line to one path, so the slice below is it.
      const lines = git(["status", "--porcelain", "--no-renames", "--", ...paths])
      return [
        ...new Set(
          lines
            .split("\n")
            .filter(Boolean)
            .map((line) => line.slice(3))
        ),
      ]
    },
    exists: (path) => existsSync(join(cwd, path)),
    recentCommits(paths) {
      const log = git(["log", `--since=${RECENT_WINDOW}`, "--format=%h %s", "--", ...paths])
      return log.split("\n").filter(Boolean)
    },
  }
}

/**
 * @param {string[]} argv
 * @param {{ cwd?: string, log?: (line: string) => void }} [io]
 * @returns {number} the exit code
 */
export function main(argv, { cwd = process.cwd(), log = console.log } = {}) {
  const options = parseArgs(argv)
  const plan = planMoves(options)
  const { errors, warnings } = preflight(plan, options.touch, gitRepo(cwd))
  for (const warning of warnings) log(`warning: ${warning}`)
  if (errors.length > 0) {
    for (const error of errors) log(`error: ${error}`)
    log(`move-to-crate: nothing moved (${errors.length} problem(s))`)
    return 1
  }
  for (const { source, target } of plan) {
    log(`${options.dryRun ? "would move" : "move"} ${source} -> ${target}`)
    if (options.dryRun) continue
    mkdirSync(dirname(join(cwd, target)), { recursive: true })
    renameSync(join(cwd, source), join(cwd, target))
  }
  const paths = ownPaths(plan, options.touch)
  if (options.pathsOut && !options.dryRun) {
    writeFileSync(resolve(cwd, options.pathsOut), `${paths.join("\n")}\n`)
  }
  log("own paths:")
  for (const path of paths) log(`  ${path}`)
  return 0
}

const isDirectRun = (() => {
  if (!process.argv[1]) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (isDirectRun) {
  try {
    process.exit(main(process.argv.slice(2)))
  } catch (error) {
    console.error(`move-to-crate: ${error.message}`)
    process.exit(2)
  }
}
