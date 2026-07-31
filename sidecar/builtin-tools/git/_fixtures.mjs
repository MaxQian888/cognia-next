// Test-only git fixtures. Underscore-prefixed so it is never matched by the
// `*.test.mjs` runner glob and never imported by production assemblers.

import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  })
}

/** A bare initialised repo (main branch, test identity) — no commits. */
export function initRepo(prefix = "cognia-git-w-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  git(["init", "-q", "-b", "main"], dir)
  git(["config", "user.email", "test@example.com"], dir)
  git(["config", "user.name", "Cognia Test"], dir)
  // Neutralise host global config so commits/tags don't try to GPG-sign or
  // annotate in CI/dev environments that set those globally.
  git(["config", "commit.gpgsign", "false"], dir)
  git(["config", "tag.gpgsign", "false"], dir)
  return dir
}

/**
 * The standard seeded repo used by the read-only tool tests: a.txt is committed
 * then modified in the working tree, b.txt is untracked, tag v0.1.0 exists.
 */
export function seededRepo() {
  const dir = initRepo("cognia-git-")
  fs.writeFileSync(path.join(dir, "a.txt"), "alpha\nbeta\n")
  git(["add", "a.txt"], dir)
  git(["commit", "-q", "-m", "first"], dir)
  fs.writeFileSync(path.join(dir, "a.txt"), "alpha\nBETA\n")
  fs.writeFileSync(path.join(dir, "b.txt"), "untracked\n")
  // Annotated tag with an explicit message so a global `tag.annotate=true`
  // can't drop us into the "no tag message" editor path. Still lists via
  // `git tag --list`, which is all the read-tool tests assert.
  git(["tag", "-m", "v0.1.0", "v0.1.0"], dir)
  return dir
}

export function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true })
}
