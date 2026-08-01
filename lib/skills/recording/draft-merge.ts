/**
 * Reconciling a regenerated draft with one the user has edited.
 *
 * The rule: **regeneration never overwrites.** Editing the timeline after a
 * draft exists makes it stale, and re-running the model produces a *candidate*
 * that sits beside the current draft until the user decides. Silently replacing
 * hand-written prose with a fresh generation is the fastest way to make someone
 * stop trusting the feature.
 *
 * Merging is per `##` section rather than per line: sections are what the skill
 * format is made of, they are what a user thinks in ("the Verify block is
 * wrong"), and a line-level merge of two independently generated prose blocks
 * produces something neither model wrote.
 */

export interface DraftBlock {
  /** Stable within one draft: the heading text, or `__preamble__`. */
  id: string
  /** Heading line, including the `##`. Empty for the preamble. */
  heading: string
  body: string
}

export const PREAMBLE_ID = "__preamble__"

/** Split markdown on `##` headings, preserving anything before the first one. */
export function splitDraftIntoBlocks(markdown: string): DraftBlock[] {
  const lines = markdown.split("\n")
  const blocks: DraftBlock[] = []
  let heading = ""
  let body: string[] = []

  const flush = () => {
    const id = heading ? heading.replace(/^#+\s*/, "").trim() : PREAMBLE_ID
    const text = body.join("\n")
    if (heading || text.trim().length > 0) {
      blocks.push({ id, heading, body: text })
    }
  }

  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      flush()
      heading = line
      body = []
    } else {
      body.push(line)
    }
  }
  flush()
  return blocks
}

export function joinDraftBlocks(blocks: readonly DraftBlock[]): string {
  return blocks
    .map((block) => (block.heading ? `${block.heading}\n${block.body}` : block.body))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export type BlockChange = "added" | "removed" | "changed" | "unchanged"

export interface BlockDiff {
  id: string
  change: BlockChange
  current: DraftBlock | null
  candidate: DraftBlock | null
}

/**
 * Section-by-section comparison.
 *
 * Order follows the candidate, then any section only the current draft has —
 * so a block the user wrote by hand and the model did not reproduce is still
 * visible rather than vanishing off the end of the list.
 */
export function diffDraftBlocks(current: string, candidate: string): BlockDiff[] {
  const currentBlocks = new Map(splitDraftIntoBlocks(current).map((b) => [b.id, b]))
  const candidateBlocks = splitDraftIntoBlocks(candidate)
  const diffs: BlockDiff[] = []
  const seen = new Set<string>()

  for (const next of candidateBlocks) {
    seen.add(next.id)
    const prior = currentBlocks.get(next.id) ?? null
    const change: BlockChange = !prior
      ? "added"
      : prior.body.trim() === next.body.trim()
        ? "unchanged"
        : "changed"
    diffs.push({ id: next.id, change, current: prior, candidate: next })
  }

  for (const [id, prior] of currentBlocks) {
    if (seen.has(id)) continue
    diffs.push({ id, change: "removed", current: prior, candidate: null })
  }
  return diffs
}

/**
 * Build the merged draft.
 *
 * `acceptedBlockIds` names the sections to take from the candidate. Everything
 * else keeps the current text verbatim — including a section the candidate
 * removed, because "the model did not mention it" is not the user asking to
 * delete their own writing.
 */
export function mergeBlocks(
  current: string,
  candidate: string,
  acceptedBlockIds: readonly string[]
): string {
  const accepted = new Set(acceptedBlockIds)
  const merged: DraftBlock[] = []

  for (const diff of diffDraftBlocks(current, candidate)) {
    if (accepted.has(diff.id)) {
      if (diff.candidate) merged.push(diff.candidate)
      // Accepting a removal means dropping the block.
      continue
    }
    if (diff.current) merged.push(diff.current)
    else if (diff.change === "added") continue
  }
  return joinDraftBlocks(merged)
}

/** Take the candidate wholesale. */
export function acceptAllBlocks(candidate: string): string {
  return joinDraftBlocks(splitDraftIntoBlocks(candidate))
}

/** Ids of every section that actually differs — what the merge UI offers. */
export function changedBlockIds(diffs: readonly BlockDiff[]): string[] {
  return diffs.filter((d) => d.change !== "unchanged").map((d) => d.id)
}
