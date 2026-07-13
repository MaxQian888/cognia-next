// JSONL exporters — two industry conventions, different purposes:
//
//  • per-message ("jsonl")     — one line per message, archival. Carries role,
//    parts, timestamp and regeneration-branch metadata, so the export round-
//    trips every branch losslessly (matches Claude Code / SillyTavern logs).
//
//  • per-conversation ("jsonl-chat") — one line per conversation as
//    `{"messages":[{role,content}]}`, the OpenAI fine-tuning / Anthropic
//    Messages shape, for training and interop. `content` is the message's
//    plain-text projection. When the message set contains regeneration
//    branches and `allBranches` is on, one line is emitted per distinct
//    root→leaf path.

import type { StoredMessage } from "@cognia/agent-config-types"
import { extractPlainText } from "@/lib/inbox/extract-plain-text"

interface BranchMeta {
  branchGroupId?: string
  branchIndex?: number
}

function branchMeta(m: StoredMessage): BranchMeta {
  const meta = (m.metadata ?? {}) as BranchMeta
  return { branchGroupId: meta.branchGroupId, branchIndex: meta.branchIndex }
}

/**
 * Per-message archival JSONL. Emits one JSON object per line in chronological
 * order. When `allBranches` is true every passed row is emitted (preserving
 * regeneration siblings); when false the list is first collapsed to the
 * default visible path (highest-`branchIndex` sibling per group).
 */
export function exportToJsonlPerMessage(messages: StoredMessage[], allBranches = true): string {
  const rows = allBranches ? messages : enumerateBranchPaths(messages, false)[0]
  return rows
    .map((m) => {
      const { branchGroupId, branchIndex } = branchMeta(m)
      return JSON.stringify({
        id: m.id,
        role: m.role,
        createdAt: m.createdAt,
        parts: m.parts,
        ...(m.senderId !== undefined ? { senderId: m.senderId } : {}),
        ...(branchGroupId !== undefined ? { branchGroupId } : {}),
        ...(branchIndex !== undefined ? { branchIndex } : {}),
      })
    })
    .join("\n")
}

/** Hard cap on enumerated branch paths — realistic chats never approach it. */
const MAX_PATHS = 200

/**
 * Collapse a flat message list (which may interleave regeneration siblings)
 * into one or more linear root→leaf paths.
 *
 * When `allBranches` is false, or there are no branch groups, a single path is
 * returned: the highest-`branchIndex` sibling per group (the chat UI's default
 * visible choice). When `allBranches` is true, the cartesian product of every
 * group's siblings is returned (capped at {@link MAX_PATHS}).
 */
export function enumerateBranchPaths(
  messages: StoredMessage[],
  allBranches: boolean
): StoredMessage[][] {
  // Group siblings by branchGroupId, in encounter order.
  const groups = new Map<string, StoredMessage[]>()
  for (const m of messages) {
    const gid = branchMeta(m).branchGroupId
    if (!gid) continue
    const arr = groups.get(gid)
    if (arr) arr.push(m)
    else groups.set(gid, [m])
  }

  const sortByIndex = (a: StoredMessage, b: StoredMessage) =>
    (branchMeta(a).branchIndex ?? 0) - (branchMeta(b).branchIndex ?? 0)

  if (groups.size === 0) return [messages]

  // Build the per-group choice lists (sorted by branchIndex).
  const groupIds = [...groups.keys()]
  const choices = groupIds.map((gid) => [...groups.get(gid)!].sort(sortByIndex))

  // Default single path: pick the last (highest-index) sibling per group.
  const pickLast = new Map<string, string>()
  for (const list of choices) {
    const gid = branchMeta(list[0]).branchGroupId!
    pickLast.set(gid, list[list.length - 1].id)
  }
  const buildPath = (chosen: Map<string, string>): StoredMessage[] =>
    messages.filter((m) => {
      const gid = branchMeta(m).branchGroupId
      if (!gid) return true
      return chosen.get(gid) === m.id
    })

  if (!allBranches) return [buildPath(pickLast)]

  // Cartesian product of every group's siblings, capped.
  let combos: Map<string, string>[] = [new Map()]
  for (let i = 0; i < groupIds.length; i++) {
    const gid = groupIds[i]
    const next: Map<string, string>[] = []
    for (const combo of combos) {
      for (const sib of choices[i]) {
        const m = new Map(combo)
        m.set(gid, sib.id)
        next.push(m)
        if (next.length >= MAX_PATHS) break
      }
      if (next.length >= MAX_PATHS) break
    }
    combos = next
  }
  return combos.map(buildPath)
}

/**
 * Per-conversation training/interop JSONL. One line per root→leaf path:
 * `{"messages":[{role,content}]}` with `content` the plain-text projection of
 * each message's parts. Empty messages (tool-only turns) are dropped.
 */
export function exportToJsonlChat(messages: StoredMessage[], allBranches = false): string {
  const paths = enumerateBranchPaths(messages, allBranches)
  return paths
    .map((path) => {
      const msgs = path
        .map((m) => ({ role: m.role, content: extractPlainText(m.parts) }))
        .filter((m) => m.content.length > 0)
      return JSON.stringify({ messages: msgs })
    })
    .join("\n")
}
