/**
 * Conversation branching — derive a new, independent chat session from an
 * existing one at a chosen message.
 *
 * Two modes (see the approved plan / ADR — conversation branching):
 *
 *  • **direct**  — copy the visible thread up to and including `messageId`
 *    into the new session as real, editable messages. The original session is
 *    never mutated. Context for the *next* turn is re-established so the new
 *    conversation's model only sees content up to the branch point:
 *      – tail branch (cut-off is the last visible message) + the source already
 *        has an SDK session → reuse the cheap SDK fork (`forkedFromSdkSessionId`);
 *        the forked SDK context is exactly the pre-branch context.
 *      – otherwise → stash a one-shot `branchSeed.transcript` that
 *        `resolveSendOptions` injects as `appendSystemPrompt` on the first send.
 *
 *  • **summary** — seed the new session with an LLM summary of the pre-branch
 *    thread instead of the raw turns. The summary is rendered as a single
 *    visible assistant message AND stashed as `branchSeed.summary` so the model
 *    picks it up on the first turn. Keeps the new branch's context window small.
 *
 * Why this lives in `lib/` (not the store): it is pure DB orchestration over
 * `lib/db/sessions` + `lib/db/messages`, fully unit-testable with a fake-indexeddb
 * Dexie. The caller (the branch dialog) is responsible for filtering the source
 * messages to the visible branch (`selectVisibleMessages`), generating/editing
 * the summary text, then activating + project-linking the returned session.
 */

import type { UIMessage } from "ai"
import type { ChatSession } from "@/lib/claude/types"
import { getDb } from "@/lib/db/schema"
import { getSession } from "@/lib/db/sessions"
import { persistMessages, invalidatePersistSnapshot } from "@/lib/db/messages"
import { extractPlainText } from "@/lib/inbox/extract-plain-text"

export type BranchMode = "direct" | "summary"

export interface BranchSessionParams {
  /** Source session id. */
  sourceId: string
  /**
   * The source session's visible (branch-filtered) messages, in chronological
   * order. The caller passes `selectVisibleMessages(messages, activeBranchByGroup)`.
   */
  visibleMessages: UIMessage[]
  /** Cut-off message id (inclusive). Must exist in `visibleMessages`. */
  messageId: string
  mode: BranchMode
  /**
   * Required for `mode === "summary"`: the (possibly user-edited) summary text
   * to seed the branch with. Ignored for direct branches.
   */
  summaryText?: string
}

function newMessageId(): string {
  return "m_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

function newSessionId(): string {
  return "s_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

const ROLE_LABEL: Record<string, string> = {
  user: "User",
  assistant: "Assistant",
  system: "System",
}

/**
 * Render a slice of the conversation as a plain-text transcript suitable for
 * injecting as model context. Empty messages (tool-only turns with no text)
 * are skipped so the seed stays compact.
 */
export function renderTranscript(messages: UIMessage[]): string {
  const lines: string[] = []
  for (const m of messages) {
    const text = extractPlainText(m.parts)
    if (!text) continue
    lines.push(`${ROLE_LABEL[m.role] ?? m.role}: ${text}`)
  }
  return lines.join("\n\n")
}

/**
 * Clone the kept messages for the new session: fresh ids, and the
 * regeneration-branch bookkeeping (`branchGroupId` / `branchIndex`) plus the
 * transient `sessionId` mirror dropped so the copy reads as a clean linear
 * thread. `senderId` / `senderKind` are preserved (team sessions hoist them
 * back into columns via `persistMessages`).
 */
function cloneMessages(kept: UIMessage[]): UIMessage[] {
  return kept.map((m) => {
    const meta = { ...((m.metadata as Record<string, unknown> | undefined) ?? {}) }
    delete meta.branchGroupId
    delete meta.branchIndex
    delete meta.sessionId
    return {
      id: newMessageId(),
      role: m.role,
      parts: m.parts,
      ...(Object.keys(meta).length > 0 ? { metadata: meta } : {}),
    } as UIMessage
  })
}

/**
 * Build the child session row, inheriting every per-session knob the parent
 * carried (so the branch behaves identically) plus the branching lineage.
 * Constructed directly rather than via `createSession` because that helper
 * copies only a subset of fields and may auto-apply the default preset.
 */
function buildChildRow(
  parent: ChatSession,
  branchedFromMessageId: string,
  kind: BranchMode
): ChatSession {
  const now = Date.now()
  return {
    id: newSessionId(),
    title: `${parent.title} (branch)`,
    titleAuto: parent.titleAuto,
    kind: parent.kind,
    characterId: parent.characterId,
    teamId: parent.teamId,
    disabledSkillIds: parent.disabledSkillIds,
    model: parent.model,
    providerOverride: parent.providerOverride,
    accountId: parent.accountId,
    sandboxEnabled: parent.sandboxEnabled,
    computerUseTarget: parent.computerUseTarget,
    systemPrompt: parent.systemPrompt,
    activePresetId: parent.activePresetId,
    workingDir: parent.workingDir,
    permissionMode: parent.permissionMode,
    bareMode: parent.bareMode,
    debugMode: parent.debugMode,
    briefMode: parent.briefMode,
    outputStyle: parent.outputStyle,
    customOutputStyle: parent.customOutputStyle,
    maxThinkingTokens: parent.maxThinkingTokens,
    toolFilter: parent.toolFilter,
    parentSessionId: parent.id,
    branchedFromMessageId,
    branchKind: kind,
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * Branch a conversation at `messageId`. Returns the freshly-created child
 * {@link ChatSession}. Throws when the source is missing or the cut-off
 * message is not in `visibleMessages`, or when a summary branch is requested
 * without `summaryText`.
 */
export async function branchSessionAtMessage(params: BranchSessionParams): Promise<ChatSession> {
  const { sourceId, visibleMessages, messageId, mode } = params

  const source = await getSession(sourceId)
  if (!source) throw new Error(`Cannot branch: session ${sourceId} not found`)

  const cutIdx = visibleMessages.findIndex((m) => m.id === messageId)
  if (cutIdx < 0) {
    throw new Error(`Cannot branch: message ${messageId} not in the visible thread`)
  }
  const kept = visibleMessages.slice(0, cutIdx + 1)

  const child = buildChildRow(source, messageId, mode)

  let seededMessages: UIMessage[]

  if (mode === "summary") {
    const summary = (params.summaryText ?? "").trim()
    if (!summary) throw new Error("Cannot branch: summary mode requires summaryText")
    // A single visible assistant message records the summary in the new thread;
    // `branchSeed.summary` carries it into the model's context on first send.
    seededMessages = [
      {
        id: newMessageId(),
        role: "assistant",
        parts: [{ type: "text", text: summary }],
        metadata: { branchSummary: true },
      } as UIMessage,
    ]
    child.branchSeed = { kind: "summary", content: summary }
  } else {
    // direct
    seededMessages = cloneMessages(kept)
    const isTail = cutIdx === visibleMessages.length - 1
    if (isTail && source.sdkSessionId) {
      // The SDK fork reproduces the parent's full context, which — at the tail —
      // is exactly the pre-branch context. Cheapest correct option.
      child.forkedFromSdkSessionId = source.sdkSessionId
    } else {
      // Mid-conversation (or no SDK session yet): re-establish the truncated
      // context explicitly on the first send.
      const transcript = renderTranscript(kept)
      if (transcript) child.branchSeed = { kind: "transcript", content: transcript }
    }
  }

  await getDb().sessions.put(child)
  // Fresh row — make sure no stale persist snapshot lingers under a recycled id.
  invalidatePersistSnapshot(child.id)
  await persistMessages(child.id, seededMessages)

  return child
}
