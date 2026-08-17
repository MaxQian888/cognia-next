/**
 * Aggregate external agent-memory discovery: run every provider, de-dupe by
 * path, and order the results agent→scope for stable display. Pure +
 * fs-injected — the renderer hook (`hooks/memory/use-external-memory.ts`)
 * supplies the real fs + home + roots.
 */

import { pathKey } from "@/lib/claude/instructions/paths"
import { discoverClaudeCode } from "./providers/claude-code"
import { discoverCodex } from "./providers/codex"
import { discoverOpencode } from "./providers/opencode"
import { discoverPi } from "./providers/pi"
import type { DiscoverCtx, ExternalAgentId, ExternalMemoryFile, ExternalMemoryScope } from "./types"

const AGENT_ORDER: ExternalAgentId[] = ["claude-code", "codex", "opencode", "pi"]
const SCOPE_ORDER: ExternalMemoryScope[] = [
  "user",
  "global",
  "managed",
  "project",
  "auto",
  "memories",
]

/** Discover every external memory file, de-duped and ordered. */
export async function discoverExternalMemory(ctx: DiscoverCtx): Promise<ExternalMemoryFile[]> {
  const [claude, codex, opencode, pi] = await Promise.all([
    discoverClaudeCode(ctx),
    discoverCodex(ctx),
    discoverOpencode(ctx),
    discoverPi(ctx),
  ])
  const byKey = new Map<string, ExternalMemoryFile>()
  // Order matters: a project `AGENTS.md` is read by BOTH Codex and OpenCode,
  // so whichever provider comes first claims the single row for that one file.
  // Codex wins because it also owns the `AGENTS.override.md` sibling.
  // Pi is last: it reads the same AGENTS.md/CLAUDE.md the others do, but only
  // contributes its own SYSTEM.md / APPEND_SYSTEM.md, so it can never steal a
  // shared row from the provider that owns it.
  for (const file of [...claude, ...codex, ...opencode, ...pi]) {
    // First writer wins; providers already emit precedence-ordered entries.
    if (!byKey.has(file.id)) byKey.set(file.id, file)
  }
  return [...byKey.values()].sort(compareFiles)
}

function compareFiles(a: ExternalMemoryFile, b: ExternalMemoryFile): number {
  const agent = AGENT_ORDER.indexOf(a.agent) - AGENT_ORDER.indexOf(b.agent)
  if (agent !== 0) return agent
  const scope = SCOPE_ORDER.indexOf(a.scope) - SCOPE_ORDER.indexOf(b.scope)
  if (scope !== 0) return scope
  return pathKey(a.absPath).localeCompare(pathKey(b.absPath))
}
