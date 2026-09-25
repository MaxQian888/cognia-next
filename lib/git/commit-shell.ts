/**
 * A `GitCommit` to hand `CommitDetail` for a sha the user picked in the
 * timeline.
 *
 * The timeline stores only the selected sha. `CommitDetail` re-reads the
 * commit's files itself, but renders its header from the commit it is given,
 * so the shell comes from whichever loaded history holds that sha, falling
 * back to a minimal stub (short hash, empty summary) when none does.
 *
 * Pure, so the desktop panel and the phone body share one spelling without
 * either importing the other.
 */

import type { GitCommit } from "@/types/git"

export function commitShell(hash: string, histories: readonly (readonly GitCommit[])[]): GitCommit {
  for (const history of histories) {
    const found = history.find((commit) => commit.hash === hash)
    if (found) return found
  }
  return {
    hash,
    shortHash: hash.slice(0, 7),
    summary: "",
    body: "",
    authorName: "",
    authorEmail: "",
    authoredAtMs: 0,
    parents: [],
  }
}
