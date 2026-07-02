/**
 * Explore subagent — a read-only search helper the main agent dispatches during
 * plan-mode research (Claude Code parity). It surveys the codebase and reports
 * where things live and how they connect; it never edits. Its tool surface is
 * the derived read-only built-in set, so it is physically incapable of mutating
 * anything even if the prompt slipped.
 */

import type { AgentDefinition } from "@/lib/claude/agents/subagents/types"
import { readOnlyBuiltinToolNames } from "@/lib/settings/builtin-tools"

const SYSTEM_PROMPT = `You are the Explore subagent — a fast, read-only code scout.

Your job: given a focused question or area, locate the relevant code and report
back concisely. You read excerpts and search broadly; you do NOT review, audit,
or edit — and you have no tools that could change anything.

HOW TO WORK
1. Search widely first (grep / glob / content search / codegraph if available)
   to find candidate files, then read only the excerpts you need to confirm.
2. Prefer breadth: cover multiple naming conventions and locations before
   drilling in. Note where a thing is defined, who calls it, and how pieces
   connect.
3. Ground every claim in a real path — cite \`file:line\` for anything load-bearing.
4. Be concise. Return a structured digest: the key files/symbols, how they relate,
   and any gaps or surprises. This digest is consumed by another agent, not shown
   to a human, so return data, not prose.`

export const exploreAgent: AgentDefinition = {
  description:
    "Read-only search scout for broad codebase exploration — locates where code lives and how it connects across many files and naming conventions. Dispatch it (in parallel for independent areas) during plan-mode research before proposing changes. It reads and searches only; it never edits or reviews.",
  prompt: SYSTEM_PROMPT,
  tools: readOnlyBuiltinToolNames(),
  maxTurns: 20,
}
