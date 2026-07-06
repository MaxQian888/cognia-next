// Core `apply_patch` tool — apply a unified diff spanning ONE OR MORE files in a
// single atomic operation. Fills the multi-file-edit gap (`multi_edit` is
// single-file only, mirroring OpenCode's `apply_patch` / Codex-style agents):
// it parses a git-style unified diff (the same format `file_diff` emits), plans
// every file change in memory, and writes ALL files only when every hunk applies
// cleanly. File creation (`--- /dev/null`) and deletion (`+++ /dev/null`) are
// supported. Mirrors `edit`/`write`: read-before-edit enforcement for existing
// files, BOM/EOL preservation, per-file locking, and best-effort LSP diagnostics
// across every touched file afterwards.

import path from "node:path"
import fsp from "node:fs/promises"
import { z } from "zod"
import { tool } from "@anthropic-ai/claude-agent-sdk"
import { applyPatch, parsePatch } from "diff"

import { toolError, toolText } from "../safety.mjs"
import { assertNotSecretEscape } from "../confinement.mjs"
import { canonicalKey } from "./read-tracker.mjs"
import { decodeText, encodeText, withFileLock } from "./text-io.mjs"
import { resolveToolPath } from "./read.mjs"
import { diagnosticsAfterWrite } from "./write.mjs"
import { replaceWithFallback, ReplaceError } from "./fuzzy-replace.mjs"

export const applyPatchShape = {
  patch: z
    .string()
    .min(1)
    .describe(
      "A unified diff (git-style — the same format `file_diff` emits) covering " +
        "one or more files. Use `--- /dev/null` to create a file and " +
        "`+++ /dev/null` to delete one. Every file is written only if all hunks " +
        "apply cleanly; otherwise nothing is written."
    ),
}

const DEV_NULL = "/dev/null"

/** A diff header naming /dev/null means the file is being created or deleted. */
function isDevNull(name) {
  return !name || name === DEV_NULL
}

/**
 * Strip the leading `a/` or `b/` prefix git adds to diff headers so the path
 * resolves against the session cwd. `parsePatch` already removes the trailing
 * tab+timestamp some tools append.
 */
function stripGitPrefix(name) {
  if (isDevNull(name)) return name
  return name.replace(/^[ab]\//, "")
}

/**
 * Reconstruct a hunk's old (context + removed) and new (context + added) text
 * blocks from its unified-diff lines. `\` "No newline at end of file" markers
 * are skipped. Returns null when the hunk has no usable old block (pure
 * insertion against unknown context — let strict applyPatch own that case).
 */
function hunkBlocks(hunk) {
  const oldLines = []
  const newLines = []
  for (const line of hunk.lines ?? []) {
    const tag = line[0]
    const body = line.slice(1)
    if (tag === " ") {
      oldLines.push(body)
      newLines.push(body)
    } else if (tag === "-") {
      oldLines.push(body)
    } else if (tag === "+") {
      newLines.push(body)
    }
    // tag === "\" → "No newline" marker, ignore.
  }
  if (oldLines.length === 0) return null
  return { oldBlock: oldLines.join("\n"), newBlock: newLines.join("\n") }
}

/**
 * Conservative rescue for a modification hunk set that strict `applyPatch`
 * rejected (context drifted past the diff library's fuzz factor). Each hunk's
 * old block is located via the shared fuzzy-replace cascade (exact →
 * line-trimmed → whitespace → indentation → block-anchor) and swapped for its
 * new block. Reuses `edit`'s matcher so behaviour is consistent across tools.
 *
 * Returns the rewritten content on success, or null when ANY hunk fails to
 * match UNIQUELY — ambiguity is never guessed; the caller then throws as
 * before. Applies hunks in reverse file order so earlier edits don't shift
 * later anchors.
 */
function tryFuzzyRescue(sourceContent, fp) {
  const hunks = Array.isArray(fp.hunks) ? [...fp.hunks] : []
  if (hunks.length === 0) return null
  hunks.sort((a, b) => (b.oldStart ?? 0) - (a.oldStart ?? 0))

  let content = sourceContent
  for (const hunk of hunks) {
    const blocks = hunkBlocks(hunk)
    if (!blocks) return null
    if (blocks.oldBlock === blocks.newBlock) continue // pure-context hunk, no-op
    try {
      content = replaceWithFallback(content, blocks.oldBlock, blocks.newBlock, false).content
    } catch (err) {
      // not_found / not_unique → refuse to guess.
      if (err instanceof ReplaceError) return null
      throw err
    }
  }
  return content
}

/**
 * Resolve one parsed file patch into a planned action (create / modify / delete)
 * against current disk content. Throws (aborting the whole patch) on any
 * mismatch — read-before-edit violation, missing file, or a hunk that doesn't
 * apply. Reads only; the write happens later in the commit phase.
 */
async function planFilePatch(fp, cwd, readTracker) {
  const creation = isDevNull(fp.oldFileName)
  const deletion = isDevNull(fp.newFileName)
  const rel = deletion ? stripGitPrefix(fp.oldFileName) : stripGitPrefix(fp.newFileName)
  if (isDevNull(rel)) throw new Error("patch is missing a target file path")
  const abs = resolveToolPath(cwd, rel)
  assertNotSecretEscape(cwd, abs)

  if (deletion) {
    let st
    try {
      st = await fsp.stat(abs)
    } catch {
      throw new Error(`cannot delete (not found): ${abs}`)
    }
    if (!st.isFile()) throw new Error(`not a regular file: ${abs}`)
    readTracker?.assertReadBefore(abs, st)
    return { abs, action: "delete" }
  }

  if (creation) {
    let exists = false
    try {
      exists = (await fsp.stat(abs)).isFile()
    } catch {
      exists = false
    }
    if (exists) {
      throw new Error(`refusing to create over an existing file: ${abs} (use a modification hunk)`)
    }
    const out = applyPatch("", fp)
    if (out === false) throw new Error(`patch does not apply cleanly to new file: ${abs}`)
    return { abs, action: "create", content: out }
  }

  // Modification.
  let st
  try {
    st = await fsp.stat(abs)
  } catch {
    throw new Error(`file not found: ${abs}`)
  }
  if (!st.isFile()) throw new Error(`not a regular file: ${abs}`)
  readTracker?.assertReadBefore(abs, st)
  const raw = await fsp.readFile(abs, "utf-8")
  const traits = decodeText(raw)
  // applyPatch compares against LF-normalized source so CRLF files still match;
  // the original traits are re-applied on write to preserve EOL/BOM.
  let out = applyPatch(traits.content, fp)
  if (out === false) {
    // Strict apply failed (context drifted past the diff fuzz factor). Try a
    // bounded, unique-match-only fuzzy rescue before giving up — but never
    // guess: an ambiguous or unfound hunk still aborts the whole patch.
    out = tryFuzzyRescue(traits.content, fp)
    if (out === null || out === false) {
      throw new Error(
        `patch does not apply cleanly: ${abs} — re-read the file and regenerate the diff`
      )
    }
  }
  return { abs, action: "modify", content: out, traits }
}

export function createApplyPatchTool({ cwd, readTracker, lspResolver }) {
  async function execApplyPatch(args) {
    let parsed
    try {
      parsed = parsePatch(args.patch)
    } catch (err) {
      return toolError(`could not parse patch: ${err.message}`, "apply_patch")
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return toolError("no file patches found in the input", "apply_patch")
    }

    // Plan phase — resolve and validate every file change in memory. Nothing is
    // written until all hunks across all files apply cleanly (atomic).
    const plans = []
    try {
      for (const fp of parsed) {
        plans.push(await planFilePatch(fp, cwd, readTracker))
      }
    } catch (err) {
      return toolError(`${err.message}. No changes were written.`, "apply_patch")
    }

    // Commit phase — apply each planned change under its own file lock.
    const summary = []
    const touched = []
    for (const p of plans) {
      await withFileLock(canonicalKey(p.abs), async () => {
        if (p.action === "delete") {
          await fsp.rm(p.abs)
          summary.push(`deleted ${p.abs}`)
          return
        }
        if (p.action === "create") {
          await fsp.mkdir(path.dirname(p.abs), { recursive: true })
          await fsp.writeFile(p.abs, p.content, "utf-8")
        } else {
          await fsp.writeFile(p.abs, encodeText(p.content, p.traits), "utf-8")
        }
        const st = await fsp.stat(p.abs)
        readTracker?.record(p.abs, st)
        summary.push(`${p.action === "create" ? "created" : "updated"} ${p.abs}`)
        touched.push(p.abs)
      })
    }

    // Best-effort LSP diagnostics across every created/modified file.
    let diag = ""
    for (const abs of touched) {
      diag += await diagnosticsAfterWrite(lspResolver, abs)
    }

    return toolText(
      `Applied patch to ${plans.length} file${plans.length === 1 ? "" : "s"}:\n` +
        `${summary.join("\n")}${diag}`
    )
  }

  return tool(
    "apply_patch",
    "Apply a unified diff (git-style) spanning one or more files in a single atomic operation. " +
      "Supports creating files (`--- /dev/null`) and deleting them (`+++ /dev/null`). " +
      "Existing files must have been read this session; if any hunk fails to apply, nothing is written. " +
      "Prefer this over multiple edit calls when one change touches several files.",
    applyPatchShape,
    execApplyPatch
  )
}
