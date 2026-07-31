/**
 * Build the document shown by `/diff` — the working tree's uncommitted changes
 * (Claude Code parity with its diff viewer). Pure: the App shells `git diff` and
 * `git diff --staged` and hands the two outputs here, so the section layout +
 * "clean tree" detection unit-test without spawning git.
 *
 * The body is markdown with each diff wrapped in a ```diff fence so the pager's
 * Markdown renderer syntax-highlights additions/deletions. Returns null when
 * there is nothing to show, so the caller can post a "clean" notice instead of
 * opening an empty pager.
 */

/** A diff section title + raw `git diff` text. */
interface DiffSection {
  heading: string
  diff: string
}

/** Trimmed line count of a non-empty diff, for the summary header. */
function changedFiles(diff: string): number {
  return diff.split("\n").filter((l) => l.startsWith("diff --git ")).length
}

/**
 * Compose the `/diff` document from the unstaged + staged `git diff` outputs.
 * Empty / whitespace-only sections are dropped. Returns null when both are empty.
 */
export function buildGitDiffDoc(
  unstaged: string,
  staged: string
): { title: string; body: string } | null {
  const sections: DiffSection[] = []
  if (staged.trim()) sections.push({ heading: "Staged changes", diff: staged.trim() })
  if (unstaged.trim()) sections.push({ heading: "Unstaged changes", diff: unstaged.trim() })
  if (sections.length === 0) return null

  const totalFiles = sections.reduce((n, s) => n + changedFiles(s.diff), 0)
  const fileWord = totalFiles === 1 ? "file" : "files"
  const parts = [`# Working tree changes`, ``, `${totalFiles} ${fileWord} changed`, ``]
  for (const s of sections) {
    parts.push(`## ${s.heading}`, ``, "```diff", s.diff, "```", ``)
  }
  return { title: "Git diff", body: parts.join("\n").trimEnd() }
}
