/**
 * Conversation-override mutation contract (ADR-0131 cross-shell inbox relay).
 *
 * Every Inbox control that edits a `conversationOverrides` row (mode
 * switcher, assignee chip, provider/model switcher, computer-use toggle, the
 * override form, lifecycle chip, label picker, pin / archive / delete in
 * settings) expresses its edit as ONE serialisable {@link ConversationOverrideMutation}.
 * The same value is:
 *
 *  - applied locally on a connector host through
 *    {@link applyConversationOverrideMutation}, which dispatches to the
 *    existing `lib/db/conversation-overrides.ts` primitives so audit rows and
 *    the assignment trail keep their exact semantics; and
 *  - shipped verbatim as `conversation_overrides_update { mutation }` from a
 *    thin client (mobile / web companion / desktop driving a remote host),
 *    where the host runs the SAME function inside
 *    `lib/companion/desktop-write-source.ts`; the client meanwhile mirrors
 *    only the affected fields via {@link applyOptimisticOverrideMutation}
 *    (no audit, no trail — the host is authoritative and syncs back).
 *
 * `setPinned` / `setArchived` / `delete` address the row by
 * `conversationKey` here even though the legacy primitives take the row id:
 * a thin client only knows the key, and the key is the unique index.
 */

import type { ConversationOverrideRow } from "@/lib/db/connector-types"
import {
  addLabel,
  deleteByConversationKey,
  patchConversationOverride,
  readForResolution,
  removeLabel,
  setArchived,
  setAssignee,
  setPinned,
  setStatus,
  updateConversationConfigSection,
  upsertByConversationKey,
  type ConversationAssignee,
  type ConversationConfigSection,
  type ConversationConfigSource,
  type ConversationOverrideInput,
  type ConversationStatus,
} from "@/lib/db/conversation-overrides"

type OverridePatch = Partial<Omit<ConversationOverrideRow, "id" | "conversationKey" | "createdAt">>

export type ConversationOverrideMutation =
  | { kind: "upsert"; input: ConversationOverrideInput }
  | { kind: "patch"; conversationKey: string; sessionId?: string; patch: OverridePatch }
  | {
      kind: "configSection"
      adapterId: string
      conversationKey: string
      sessionId?: string
      section: ConversationConfigSection
      patch: OverridePatch
      source?: ConversationConfigSource
    }
  | {
      kind: "setStatus"
      conversationKey: string
      status: ConversationStatus
      sessionId?: string
      snoozeUntil?: number
    }
  | {
      kind: "setAssignee"
      conversationKey: string
      assignee: ConversationAssignee | null
      sessionId?: string
      via?: string
      adapterId?: string
    }
  | { kind: "addLabel"; conversationKey: string; labelId: string; sessionId?: string }
  | { kind: "removeLabel"; conversationKey: string; labelId: string; sessionId?: string }
  | { kind: "setPinned"; conversationKey: string; pinned: boolean; sessionId?: string }
  | { kind: "setArchived"; conversationKey: string; archived: boolean; sessionId?: string }
  | { kind: "delete"; conversationKey: string }

export type ConversationOverrideMutationKind = ConversationOverrideMutation["kind"]

export const CONVERSATION_OVERRIDE_MUTATION_KINDS: readonly ConversationOverrideMutationKind[] = [
  "upsert",
  "patch",
  "configSection",
  "setStatus",
  "setAssignee",
  "addLabel",
  "removeLabel",
  "setPinned",
  "setArchived",
  "delete",
]

/** The conversation a mutation targets. */
export function conversationKeyOfMutation(mutation: unknown): string | undefined {
  if (!mutation || typeof mutation !== "object") return undefined
  const value = mutation as { kind?: unknown; conversationKey?: unknown; input?: unknown }
  if (value.kind === "upsert") {
    const input = value.input as { conversationKey?: unknown } | undefined
    return typeof input?.conversationKey === "string" ? input.conversationKey : undefined
  }
  return typeof value.conversationKey === "string" ? value.conversationKey : undefined
}

/**
 * Structural validation for a value that arrived over the wire
 * (`conversation_overrides_update { mutation }`). Checks the discriminator,
 * the conversation key, and the per-kind required fields — deep field
 * validation of `patch` / `input` is left to the Dexie primitives, which
 * only accept known override columns.
 */
export function isConversationOverrideMutation(value: unknown): value is ConversationOverrideMutation {
  if (!value || typeof value !== "object") return false
  const m = value as Record<string, unknown>
  if (!CONVERSATION_OVERRIDE_MUTATION_KINDS.includes(m.kind as ConversationOverrideMutationKind)) {
    return false
  }
  const key = conversationKeyOfMutation(value)
  if (!key) return false
  const isObject = (v: unknown): boolean => !!v && typeof v === "object" && !Array.isArray(v)
  const optionalString = (v: unknown): boolean => v === undefined || typeof v === "string"
  switch (m.kind as ConversationOverrideMutationKind) {
    case "upsert":
      return isObject(m.input) && typeof (m.input as { sessionId?: unknown }).sessionId === "string"
    case "patch":
      return isObject(m.patch) && optionalString(m.sessionId)
    case "configSection":
      return (
        typeof m.adapterId === "string" &&
        isObject(m.patch) &&
        ["behavior", "responder", "permissions", "delivery"].includes(m.section as string) &&
        optionalString(m.sessionId) &&
        optionalString(m.source)
      )
    case "setStatus":
      return (
        ["open", "pending", "snoozed", "resolved"].includes(m.status as string) &&
        optionalString(m.sessionId) &&
        (m.snoozeUntil === undefined || typeof m.snoozeUntil === "number")
      )
    case "setAssignee": {
      const assignee = m.assignee
      const validAssignee =
        assignee === null ||
        (isObject(assignee) &&
          ["human", "character", "team"].includes((assignee as { kind?: unknown }).kind as string) &&
          typeof (assignee as { id?: unknown }).id === "string")
      return validAssignee && optionalString(m.sessionId) && optionalString(m.via)
    }
    case "addLabel":
    case "removeLabel":
      return typeof m.labelId === "string" && optionalString(m.sessionId)
    case "setPinned":
      return typeof m.pinned === "boolean" && optionalString(m.sessionId)
    case "setArchived":
      return typeof m.archived === "boolean" && optionalString(m.sessionId)
    case "delete":
      return true
  }
}

export interface ApplyOverrideMutationOptions {
  /**
   * Provenance appended to the assignment trail (`setAssignee` `via`) and the
   * config-section audit source when the mutation itself carries none — the
   * host arm passes `device:<callerDeviceId>` so a phone-originated change is
   * attributable.
   */
  via?: string
}

/**
 * Apply a mutation with FULL semantics (audit + assignment trail) on the
 * host that owns the `conversationOverrides` table. Returns the resulting
 * row when the primitive yields one, `undefined` for trail-only / delete.
 */
export async function applyConversationOverrideMutation(
  mutation: ConversationOverrideMutation,
  options: ApplyOverrideMutationOptions = {}
): Promise<ConversationOverrideRow | undefined> {
  switch (mutation.kind) {
    case "upsert":
      return upsertByConversationKey(mutation.input)
    case "patch":
      return patchConversationOverride(mutation.conversationKey, mutation.patch, mutation.sessionId)
    case "configSection": {
      // The operator taking routing over by hand is expressed by spreading
      // `ASSIGNMENT_ROUTING_MARKER_CLEAR` into `patch` at the call site
      // (`components/inbox/overrides/conversation-override-form.tsx`), so the
      // clear lands in the SAME write — and therefore also in the mutation a
      // thin client relays, with no second round trip.
      return updateConversationConfigSection({
        adapterId: mutation.adapterId,
        conversationKey: mutation.conversationKey,
        sessionId: mutation.sessionId,
        section: mutation.section,
        patch: mutation.patch,
        source: mutation.source ?? (options.via ? "mobile" : undefined),
      })
    }
    case "setStatus":
      await setStatus(mutation.conversationKey, mutation.status, {
        sessionId: mutation.sessionId,
        snoozeUntil: mutation.snoozeUntil,
      })
      return readForResolution(mutation.conversationKey)
    case "setAssignee":
      await setAssignee(mutation.conversationKey, mutation.assignee, {
        sessionId: mutation.sessionId,
        via: mutation.via ?? options.via,
        adapterId: mutation.adapterId,
      })
      return readForResolution(mutation.conversationKey)
    case "addLabel":
      await addLabel(mutation.conversationKey, mutation.labelId, mutation.sessionId)
      return readForResolution(mutation.conversationKey)
    case "removeLabel":
      await removeLabel(mutation.conversationKey, mutation.labelId, mutation.sessionId)
      return readForResolution(mutation.conversationKey)
    case "setPinned": {
      const row = await readForResolution(mutation.conversationKey)
      if (row) {
        await setPinned(row.id, mutation.pinned)
        return { ...row, pinned: mutation.pinned }
      }
      return patchConversationOverride(
        mutation.conversationKey,
        { pinned: mutation.pinned },
        mutation.sessionId
      )
    }
    case "setArchived": {
      const row = await readForResolution(mutation.conversationKey)
      if (row) {
        await setArchived(row.id, mutation.archived)
        return { ...row, archived: mutation.archived }
      }
      return patchConversationOverride(
        mutation.conversationKey,
        { archived: mutation.archived },
        mutation.sessionId
      )
    }
    case "delete":
      await deleteByConversationKey(mutation.conversationKey)
      return undefined
  }
}

/**
 * Optimistic mirror for a thin client: write ONLY the fields the mutation
 * names into the local `conversationOverrides` mirror so the UI reflects the
 * change immediately. No audit rows, no assignment-trail entries, no
 * assignment ↔ routing sync — all of that happens once on the host, whose
 * row then replaces this one through companion sync. Rows that do not exist
 * locally yet are created when the mutation carries a `sessionId`; otherwise
 * the optimistic step is skipped (the sync will materialise the row).
 */
export async function applyOptimisticOverrideMutation(
  mutation: ConversationOverrideMutation
): Promise<void> {
  const patchLocal = async (
    conversationKey: string,
    patch: OverridePatch,
    sessionId?: string
  ): Promise<void> => {
    const existing = await readForResolution(conversationKey)
    if (!existing && !sessionId) return
    await patchConversationOverride(conversationKey, patch, sessionId)
  }
  switch (mutation.kind) {
    case "upsert":
      await upsertByConversationKey(mutation.input)
      return
    case "patch":
      await patchLocal(mutation.conversationKey, mutation.patch, mutation.sessionId)
      return
    case "configSection":
      await patchLocal(mutation.conversationKey, mutation.patch, mutation.sessionId)
      return
    case "setStatus":
      await patchLocal(
        mutation.conversationKey,
        {
          status: mutation.status,
          snoozeUntil: mutation.status === "snoozed" ? mutation.snoozeUntil : undefined,
        },
        mutation.sessionId
      )
      return
    case "setAssignee":
      await patchLocal(
        mutation.conversationKey,
        {
          assignee: mutation.assignee ?? undefined,
          assigneeKind: mutation.assignee?.kind,
        },
        mutation.sessionId
      )
      return
    case "addLabel": {
      const row = await readForResolution(mutation.conversationKey)
      const current = row?.labelIds ?? []
      if (current.includes(mutation.labelId)) return
      await patchLocal(
        mutation.conversationKey,
        { labelIds: [...current, mutation.labelId] },
        mutation.sessionId
      )
      return
    }
    case "removeLabel": {
      const row = await readForResolution(mutation.conversationKey)
      const current = row?.labelIds ?? []
      if (!current.includes(mutation.labelId)) return
      await patchLocal(
        mutation.conversationKey,
        { labelIds: current.filter((id) => id !== mutation.labelId) },
        mutation.sessionId
      )
      return
    }
    case "setPinned":
      await patchLocal(mutation.conversationKey, { pinned: mutation.pinned }, mutation.sessionId)
      return
    case "setArchived":
      await patchLocal(
        mutation.conversationKey,
        { archived: mutation.archived },
        mutation.sessionId
      )
      return
    case "delete":
      await deleteByConversationKey(mutation.conversationKey)
      return
  }
}
