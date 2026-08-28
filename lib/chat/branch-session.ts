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
import type { ChatSession } from "@cognia/agent-config-types"
import { getDb } from "@/lib/db/schema"
import { assertSessionWritable } from "@/lib/chat/session-write-guard"
import { getSession } from "@/lib/db/sessions"
import { resolveScopeProjectId } from "@/lib/db/project-scope"
import { persistMessages, invalidatePersistSnapshot } from "@/lib/db/messages"
import { extractPlainText } from "@/lib/inbox/extract-plain-text"

export type BranchMode = "direct" | "summary"

/**
 * Character budget for a direct branch's one-shot transcript seed.
 *
 * This was previously unbounded, and it is the one seed that rides on a
 * *stored* row: `branchSeed.content` lives on the `sessions` record, which the
 * sidebar reads in full via `listScopedSessions().toArray()` on every render.
 * Branching mid-way through a long conversation therefore wrote a multi-megabyte
 * string into a row on the sidebar's hot path, and injected all of it as
 * `appendSystemPrompt` on the first send.
 *
 * Matches `MAX_TRANSCRIPT_CHARS` in `lib/ai/generation/summarizer.ts` — the same
 * ~4-chars-per-token proxy, chosen so the two paths a branch can take cost the
 * same ceiling. Compare `ASIDE_CONTEXT_MAX_CHARS`, which is far tighter because
 * it rides on *every* aside send rather than once.
 */
export const BRANCH_SEED_MAX_CHARS = 24_000

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
  /**
   * Cherry-pick: carry only these message ids across, instead of everything up
   * to the cut-off.
   *
   * For a long thread where the useful part is three conclusions scattered
   * through forty turns — taking the whole prefix would drag the dead ends
   * along, and the model would weigh them equally. Ids outside the kept prefix
   * are ignored, so a selection can never smuggle in content from *after* the
   * branch point.
   *
   * Absent (the default) keeps the existing behaviour: everything up to and
   * including `messageId`.
   */
  pickedMessageIds?: readonly string[]
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
 * Render `messages` as a transcript that fits {@link BRANCH_SEED_MAX_CHARS}.
 *
 * Trims from the OLDEST end, dropping whole messages rather than cutting one
 * mid-sentence — the same rule `buildAsideContext` uses, and for the same
 * reason: a half message reads as though the speaker was interrupted, which the
 * model then imitates. The turns nearest the branch point are the ones the user
 * is continuing from, so they are the ones that must survive.
 *
 * Returns the rendered seed plus whether anything was dropped.
 *
 * `truncated` is **not surfaced anywhere yet** — the only production caller
 * (`buildChildRow`) destructures `content` alone. It is kept because the drop is
 * otherwise invisible: a verbatim branch silently loses its earliest turns, and
 * the branch dialog is where "a summary branch would carry that context better"
 * belongs. Wiring it needs a string in `chat.branch.direct`, which does not
 * exist. Pinned by the tests either way, so the trimming rule cannot regress
 * while it waits.
 */
export function renderBranchSeed(
  messages: UIMessage[],
  maxChars: number = BRANCH_SEED_MAX_CHARS
): { content: string; truncated: boolean } {
  let kept = messages
  let rendered = renderTranscript(kept)
  if (rendered.length <= maxChars) return { content: rendered, truncated: false }

  while (rendered.length > maxChars && kept.length > 1) {
    kept = kept.slice(1)
    rendered = renderTranscript(kept)
  }
  // A single message over budget is still better truncated than dropped — it is
  // the turn immediately before the branch point.
  return {
    content: rendered.length > maxChars ? rendered.slice(-maxChars) : rendered,
    truncated: true,
  }
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
 * Session kinds that only exist inside a host surface. `isEmbeddedSession`
 * treats each as hidden from the conversation rail, global search, plugin
 * enumeration and export, and each is reachable only through the surface that
 * owns its `surfaceBinding`.
 *
 * A branch is a standalone conversation and gets neither, so copying the kind
 * across produced a row that every list filtered out AND no workbench could
 * render — reachable from nothing, deletable from nowhere.
 */
const EMBEDDED_KINDS: ReadonlySet<ChatSession["kind"]> = new Set([
  "resource-workbench",
  "subagent",
  "workflow-editor",
] as const)

/**
 * Title for a branch of `parent`, without stacking suffixes.
 *
 * Branching a branch used to yield "X (branch) (branch) (branch)"; the depth is
 * already carried by `parentSessionId`, and the sidebar truncates long titles,
 * so the repetition cost readability and told the user nothing.
 */
export function branchTitle(parentTitle: string): string {
  const match = /^(.*) \(branch(?: (\d+))?\)$/.exec(parentTitle)
  if (!match) return `${parentTitle} (branch)`
  const [, stem, ordinal] = match
  return `${stem} (branch ${Number(ordinal ?? "1") + 1})`
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
  kind: BranchMode,
  projectId: string
): ChatSession {
  const now = Date.now()
  return {
    id: newSessionId(),
    // Load-bearing, not inherited-for-tidiness. `listScopedSessions` reads
    // through the `[projectId+updatedAt]` compound index and Dexie omits any
    // row whose key path contains `undefined` — so a branch written without a
    // workspace is not merely mis-scoped, it is absent from the sidebar
    // entirely, and from the `deleteProjectCascade` sweep with it. The caller
    // resolves the value (this stays synchronous); it inherits the parent's
    // workspace rather than whatever is active, so branching a conversation
    // from another workspace files the branch beside its parent.
    projectId,
    title: branchTitle(parent.title),
    titleAuto: parent.titleAuto,
    // Normalised, not inherited. Branching a sidechat used to mint a
    // `resource-workbench` row with no `visibility` and no `surfaceBinding` —
    // filtered out of every list by `isEmbeddedSession`, and renderable by no
    // workbench because nothing bound it. `visibility` / `surfaceBinding` /
    // `surfaceBindingKey` are deliberately absent below, so the branch is a
    // plain standalone conversation however it was started.
    kind: parent.kind && EMBEDDED_KINDS.has(parent.kind) ? "direct" : parent.kind,
    characterId: parent.characterId,
    teamId: parent.teamId,
    // Inherited alongside the other two identity columns: a branch continues
    // the same conversation, so it continues to run on the same executor.
    squadId: parent.squadId,
    disabledSkillIds: parent.disabledSkillIds,
    messageDisplayOverride: parent.messageDisplayOverride,
    model: parent.model,
    providerOverride: parent.providerOverride,
    accountId: parent.accountId,
    sandboxEnabled: parent.sandboxEnabled,
    computerUseTarget: parent.computerUseTarget,
    // The third sandbox column, and the one that kept being missed. Without it
    // a branch re-resolves its tier from whatever `AppSettings.sandboxTier` says
    // *now* (`lib/sandbox/binding.ts`), so a child of a `microvm` conversation
    // can silently run on `os`. Isolation must never decrease unannounced.
    sandboxTier: parent.sandboxTier,
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
  assertSessionWritable(source, "branch")

  const cutIdx = visibleMessages.findIndex((m) => m.id === messageId)
  if (cutIdx < 0) {
    throw new Error(`Cannot branch: message ${messageId} not in the visible thread`)
  }
  const prefix = visibleMessages.slice(0, cutIdx + 1)
  // Cherry-pick narrows the prefix; it can never widen it. Filtering the prefix
  // rather than the whole thread is what guarantees a selection cannot carry
  // content from after the branch point into the child.
  const picked = params.pickedMessageIds ? new Set(params.pickedMessageIds) : null
  const kept = picked ? prefix.filter((m) => picked.has(m.id)) : prefix
  if (kept.length === 0) {
    throw new Error("Cannot branch: nothing selected before the branch point")
  }

  // Inherit the parent's workspace; only a parent that predates the v131
  // backfill can be missing one, in which case fall back to the active scope.
  const projectId = source.projectId ?? (await resolveScopeProjectId())
  const child = buildChildRow(source, messageId, mode, projectId)

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
    // A cherry-pick never reuses the SDK fork, even at the tail: the fork
    // reproduces the parent's context in FULL, which is the opposite of what
    // was asked for — the child would show three messages while the model
    // silently remembered all forty.
    const isTail = cutIdx === visibleMessages.length - 1 && !picked
    if (isTail && source.sdkSessionId) {
      // The SDK fork reproduces the parent's full context, which — at the tail —
      // is exactly the pre-branch context. Cheapest correct option.
      child.forkedFromSdkSessionId = source.sdkSessionId
    } else {
      // Mid-conversation (or no SDK session yet): re-establish the truncated
      // context explicitly on the first send.
      const { content } = renderBranchSeed(kept)
      if (content) child.branchSeed = { kind: "transcript", content }
    }
  }

  await getDb().sessions.put(child)
  // Fresh row — make sure no stale persist snapshot lingers under a recycled id.
  invalidatePersistSnapshot(child.id)
  await persistMessages(child.id, seededMessages)

  return child
}
