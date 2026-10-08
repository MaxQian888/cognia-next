/**
 * Parse unified diff text — one file or many, git-style or bare — into the
 * same {@link GitHunk} shape libgit2 produces, so a patch an agent wrote or a
 * ```diff block in a message renders through the git hunk path
 * (`gitHunksToDiffRows` → `LineDiffView`) instead of a parser of its own.
 *
 * Lenient on purpose. The text comes from models and humans, not from git:
 * hunk counts are often wrong, trailing blank context lines lose their leading
 * space, and a "diff" may be nothing but `+` / `-` lines. Counts are recomputed
 * from the lines actually present; a run of change lines with no `@@` header
 * becomes one unnumbered hunk (`header === ""`) rather than being dropped.
 */

import type { GitDiffLine, GitHunk } from "@/types/git"

export type PatchFileChange = "added" | "deleted" | "modified" | "renamed"

export interface PatchFile {
  /** Path before the change; `null` for a created file or a headerless diff. */
  oldPath: string | null
  /** Path after the change; `null` for a deleted file or a headerless diff. */
  newPath: string | null
  change: PatchFileChange
  binary: boolean
  hunks: GitHunk[]
  added: number
  removed: number
}

const DEV_NULL = "/dev/null"
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/** The path a reader should see for a file: the new one, else the old one. */
export function patchFilePath(file: Pick<PatchFile, "oldPath" | "newPath">): string | null {
  return file.newPath ?? file.oldPath
}

/**
 * `--- a/src/x.ts\t2024-01-01` → `src/x.ts`; `/dev/null` → null. Quoted git
 * paths (`"a/with space"`) are unquoted; the `a/` / `b/` prefix is dropped.
 */
function headerPath(raw: string): string | null {
  let value = raw.replace(/\t.*$/, "").trim()
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    value = value.slice(1, -1).replace(/\\(.)/g, "$1")
  }
  if (value === DEV_NULL || value === "") return null
  return value.replace(/^[ab]\//, "")
}

/** `diff --git a/x b/y` → `{ old: "x", new: "y" }` when unambiguous. */
function gitHeaderPaths(line: string): { old: string; new: string } | null {
  const rest = line.slice("diff --git ".length)
  const match = /^a\/(.+) b\/(.+)$/.exec(rest)
  if (!match) return null
  return { old: match[1], new: match[2] }
}

interface FileBuild {
  oldPath: string | null
  newPath: string | null
  created: boolean
  deleted: boolean
  renamed: boolean
  binary: boolean
  header: string[]
  hunks: GitHunk[]
}

interface HunkBuild {
  header: string
  oldStart: number
  newStart: number
  /** Lines the header promised on each side, counted down as lines arrive. */
  oldLeft: number
  newLeft: number
  text: string[]
  lines: GitDiffLine[]
}

function emptyFile(): FileBuild {
  return {
    oldPath: null,
    newPath: null,
    created: false,
    deleted: false,
    renamed: false,
    binary: false,
    header: [],
    hunks: [],
  }
}

function finishHunk(file: FileBuild, hunk: HunkBuild) {
  let oldLines = 0
  let newLines = 0
  for (const line of hunk.lines) {
    if (line.kind !== "add") oldLines++
    if (line.kind !== "del") newLines++
  }
  if (hunk.lines.length === 0) return
  const fileHeader = file.header.length > 0 ? `${file.header.join("\n")}\n` : ""
  file.hunks.push({
    header: hunk.header,
    oldStart: hunk.oldStart,
    oldLines,
    newStart: hunk.newStart,
    newLines,
    patch: `${fileHeader}${hunk.text.join("\n")}\n`,
    lines: hunk.lines,
  })
}

function finishFile(file: FileBuild): PatchFile | null {
  if (file.hunks.length === 0 && !file.binary && !file.created && !file.deleted && !file.renamed) {
    return null
  }
  let added = 0
  let removed = 0
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "add") added++
      else if (line.kind === "del") removed++
    }
  }
  const created = file.created || (file.oldPath === null && file.newPath !== null)
  const deleted = file.deleted || (file.newPath === null && file.oldPath !== null)
  const change: PatchFileChange = created
    ? "added"
    : deleted
      ? "deleted"
      : file.renamed || (file.oldPath !== null && file.newPath !== file.oldPath)
        ? "renamed"
        : "modified"
  return {
    oldPath: created ? null : file.oldPath,
    newPath: deleted ? null : file.newPath,
    change,
    binary: file.binary,
    hunks: file.hunks,
    added,
    removed,
  }
}

/** Parse unified diff text into its files, in order. Never throws. */
export function parseUnifiedPatch(text: string): PatchFile[] {
  const files: PatchFile[] = []
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  // A trailing newline is the end of the last line, not an empty line after it.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()

  let file: FileBuild | null = null
  let hunk: HunkBuild | null = null

  const closeHunk = () => {
    if (file && hunk) finishHunk(file, hunk)
    hunk = null
  }
  const closeFile = () => {
    closeHunk()
    if (file) {
      const done = finishFile(file)
      if (done) files.push(done)
    }
    file = null
  }
  const ensureFile = (): FileBuild => {
    if (!file) file = emptyFile()
    return file
  }
  const looseHunk = (): HunkBuild => ({
    header: "",
    oldStart: 0,
    newStart: 0,
    oldLeft: 0,
    newLeft: 0,
    text: [],
    lines: [],
  })

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (line.startsWith("diff --git ")) {
      closeFile()
      const current = ensureFile()
      const paths = gitHeaderPaths(line)
      if (paths) {
        current.oldPath = paths.old
        current.newPath = paths.new
      }
      current.header.push(line)
      continue
    }

    // `--- x` followed by `+++ y` opens a file (or the file `diff --git`
    // already opened). Checked before change lines: `---` would otherwise
    // read as a removal of "-- x".
    if (line.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")) {
      const continuing = file !== null && hunk === null && (file as FileBuild).hunks.length === 0
      if (!continuing) closeFile()
      else closeHunk()
      const current = ensureFile()
      current.oldPath = headerPath(line.slice(4))
      current.newPath = headerPath(lines[i + 1].slice(4))
      current.header.push(line, lines[i + 1])
      i++
      continue
    }

    const header = HUNK_HEADER.exec(line)
    if (header) {
      closeHunk()
      ensureFile()
      hunk = {
        header: line,
        oldStart: Number(header[1]),
        newStart: Number(header[3]),
        oldLeft: header[2] === undefined ? 1 : Number(header[2]),
        newLeft: header[4] === undefined ? 1 : Number(header[4]),
        text: [line],
        lines: [],
      }
      continue
    }

    // Git's extended headers, only meaningful between the file header and
    // its first hunk.
    if (file && !hunk) {
      const current: FileBuild = file
      if (line.startsWith("new file mode")) {
        current.created = true
        current.header.push(line)
        continue
      }
      if (line.startsWith("deleted file mode")) {
        current.deleted = true
        current.header.push(line)
        continue
      }
      if (line.startsWith("rename from ")) {
        current.renamed = true
        current.oldPath = line.slice("rename from ".length)
        current.header.push(line)
        continue
      }
      if (line.startsWith("rename to ")) {
        current.renamed = true
        current.newPath = line.slice("rename to ".length)
        current.header.push(line)
        continue
      }
      if (line.startsWith("Binary files ") || line === "GIT binary patch") {
        current.binary = true
        current.header.push(line)
        continue
      }
      if (
        line.startsWith("index ") ||
        line.startsWith("old mode") ||
        line.startsWith("new mode") ||
        line.startsWith("similarity index") ||
        line.startsWith("dissimilarity index") ||
        line.startsWith("copy from ") ||
        line.startsWith("copy to ")
      ) {
        current.header.push(line)
        continue
      }
    }

    if (line.startsWith("\\")) {
      // "\ No newline at end of file": the line before it has no terminator.
      const target = hunk as HunkBuild | null
      const last = target?.lines[target.lines.length - 1]
      if (target && last) {
        last.content = last.content.replace(/\n$/, "")
        target.text.push(line)
      }
      continue
    }

    const sign = line[0]
    const isChange = sign === "+" || sign === "-"
    // A blank line inside a hunk that still expects lines is context whose
    // leading space was trimmed away.
    const isContext =
      sign === " " ||
      (line === "" &&
        hunk !== null &&
        ((hunk as HunkBuild).oldLeft > 0 || (hunk as HunkBuild).newLeft > 0))
    if (!isChange && !isContext) {
      // Prose between files, or the end of a headerless run.
      if (hunk && (hunk as HunkBuild).header === "") closeHunk()
      continue
    }
    if (!hunk) {
      // Diff lines with no `@@` above them: a bare diff.
      ensureFile()
      hunk = looseHunk()
    }
    const current: HunkBuild = hunk
    const content = `${line.slice(1)}\n`
    if (sign === "+") {
      current.lines.push({ kind: "add", content })
      current.newLeft--
    } else if (sign === "-") {
      current.lines.push({ kind: "del", content })
      current.oldLeft--
    } else {
      current.lines.push({ kind: "context", content })
      current.oldLeft--
      current.newLeft--
    }
    current.text.push(line === "" ? " " : line)
  }

  closeFile()
  return files
}
