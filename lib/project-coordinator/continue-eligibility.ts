import type { ChatSession } from "@cognia/agent-config-types"
import type { ChatStatus } from "@/stores/chat/chat-store"

/**
 * Whether a conversation can "Continue as project" (ADR-0204). Pure and
 * dependency-free: every conversation row asks it to decide whether to offer
 * the action, and the action itself (`continue-as-project.ts`) is only loaded
 * when someone picks it.
 */

export type ContinueAsProjectRefusal =
  "missing" | "no-workspace" | "already-project" | "linked" | "busy"

/** Why a conversation cannot become a project thread, or null when it can. */
export function continueAsProjectRefusal(
  session: ChatSession | undefined,
  status: ChatStatus = "idle"
): ContinueAsProjectRefusal | null {
  if (!session) return "missing"
  if (!session.projectId) return "no-workspace"
  if (session.projectRole) return "already-project"
  // A branch, aside or teammate conversation belongs to another lifecycle.
  if (session.parentSessionId || session.attachedChild || session.kind !== "direct") return "linked"
  if (status !== "idle") return "busy"
  return null
}
