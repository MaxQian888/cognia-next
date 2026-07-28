/**
 * Built-in-skill context hydration (W2 — closes an ADR-0026 trust-model gap).
 *
 * The sidecar tool-exec IPC path (`lib/claude/plugin-tool-ipc.ts`) used to
 * call `runBuiltInSkill(id, args, { sessionId })` with a BARE context: no
 * `imBinding`, no `imOverrideRow`. Since every dispatcher gate keys off
 * `ctx.imBinding` (imAccess tier, per-chat allowlist, HITL), tool-call
 * invocations from IM-bound sessions silently bypassed the entire pipeline —
 * write skills executed without confirm cards.
 *
 * `resolveBuiltInSkillContext` loads the session, and when it carries a
 * `platformBinding`, populates `imBinding` + the conversation's override row
 * (same lookup `enqueueOutbound` uses). Desktop sessions come back with just
 * `sessionId` — the desktop HITL path handles those.
 */

import type { BuiltInSkillContext } from "./types"
import { primaryRootOf } from "@/lib/workspace/roots"

export async function resolveBuiltInSkillContext(sessionId: string): Promise<BuiltInSkillContext> {
  const ctx: BuiltInSkillContext = { sessionId }
  try {
    const { getDb } = await import("@/lib/db/schema")
    const db = getDb()
    const session = await db.sessions.get(sessionId)
    const sessionRoot = session?.workingDir?.trim()
    if (sessionRoot) {
      ctx.workspaceRoot = sessionRoot
    } else if (session?.projectId) {
      try {
        const project = await db.projects.get(session.projectId)
        const projectRoot = project ? primaryRootOf(project)?.path.trim() : undefined
        if (projectRoot) ctx.workspaceRoot = projectRoot
      } catch {
        // A missing project row leaves the skill unavailable; connector
        // binding hydration below must still proceed.
      }
    }
    const binding = session?.platformBinding
    if (!binding?.conversationKey) return ctx
    ctx.imBinding = {
      adapterId: binding.adapterId,
      platform: binding.platform,
      conversationKey: binding.conversationKey,
    }
    try {
      const { readForResolution } = await import("@/lib/db/conversation-overrides")
      ctx.imOverrideRow = (await readForResolution(binding.conversationKey)) ?? undefined
    } catch {
      // Missing override row is the common case; a failed read must not
      // block the invocation — the dispatcher treats undefined as
      // "no per-chat config" (default gates still apply).
    }
    return ctx
  } catch {
    // Session lookup failed (torn-down DB in tests, etc.) — fall back to the
    // bare context; the dispatcher's non-IM path takes over.
    return ctx
  }
}
