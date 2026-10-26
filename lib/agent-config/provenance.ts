/**
 * Line provenance of a file-backed surface (ADR-0238 §4).
 *
 * The prompt-audit method orders two conflicting instructions by `git blame`,
 * never by file timestamps or by what a file claims about itself, and dates a
 * rule to the model era it was written in. This answers that question for an
 * instruction or agent file the discovery listed — never for an arbitrary path
 * — and returns only the commit and its time. Author names and commit messages
 * stay on the host: they identify people and would ride along to a model.
 */

import { gitBlame } from "@/lib/git/commands"
import { basename, dirname, joinPath } from "@/lib/claude/instructions/paths"
import { parseInstructionFileKey } from "@/lib/prompts/adapters/instruction-files"
import { parseResourceKey } from "@/lib/prompts/resources"
import { parseAgentFileKey } from "./surfaces"
import type { AgentConfigLineProvenance } from "./types"

/** Absolute path of a file-backed surface key, or `undefined` for every other owner. */
export function surfaceFilePath(key: string): string | undefined {
  const { source } = parseResourceKey(key)
  if (source === "instruction-file") {
    const ref = parseInstructionFileKey(key)
    return joinPath(ref.root, ref.name)
  }
  if (source === "agent-file") {
    const ref = parseAgentFileKey(key)
    return joinPath(ref.dir, ref.name)
  }
  return undefined
}

/** git reports lines that are not committed yet with an all-zero hash. */
const UNCOMMITTED = /^0+$/

export async function readAgentConfigProvenance(
  key: string,
  blame: typeof gitBlame = gitBlame
): Promise<AgentConfigLineProvenance[] | null> {
  const path = surfaceFilePath(key)
  if (!path) return null
  let lines: Awaited<ReturnType<typeof gitBlame>>
  try {
    // Run from the file's own directory: git finds the repository upward.
    lines = await blame(dirname(path), basename(path))
  } catch {
    return null
  }
  if (lines.length === 0) return null
  return lines.map((line) => ({
    line: line.lineNumber,
    commit: UNCOMMITTED.test(line.commitHash) ? "" : line.commitHash,
    authoredAtMs: line.authoredAtMs,
  }))
}
