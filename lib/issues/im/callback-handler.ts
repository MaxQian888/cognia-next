/**
 * Bus-side dispatcher for `issue_action` callback bindings (ADR-0132 slice ③).
 *
 * Companion to `lib/a2ui/workflow-approval-handler.ts`: `ConnectorBus.
 * runConnectorCallback` short-circuits `issue_action` bindings here so the
 * click is applied directly and answered with a tight reply / refreshed card,
 * never a model digest turn.
 *
 * Actions (payload shapes in `./card.ts`):
 *   - `move`          → `moveIssue` through the SAME guard the desktop board
 *                       uses (`lib/issues/state-machine.ts`); a denial is
 *                       replied, never silently dropped.
 *   - `run`           → `startIssueRun` with `origin: "im"` (headless gate
 *                       policy) on the first engine that can run it.
 *   - `create`        → file the draft into the chosen project, remember the
 *                       project on the conversation (`issueProjectId`), reply
 *                       with the new issue's card, and consume the
 *                       confirmation card's sibling bindings so nothing
 *                       double-files.
 *   - `cancel_create` → consume the confirmation card; nothing written.
 *
 * Move/run buttons stay re-clickable (a card is a live control, not a
 * one-shot approval); only the create confirmation is consumed once.
 */

import type { ConnectorCallbackBindingRow } from "@/types/connectors/interaction"
import type { PlatformIdentity } from "@/types/connectors/event"
import type { Issue, IssueActor, IssueStatus } from "@/types/issues"
import { ISSUE_STATUSES } from "@/types/issues"
import { getDb } from "@/lib/db/schema"
import { patchConversationOverride } from "@/lib/db/conversation-overrides"
import { createIssue, getIssue, moveIssue } from "@/lib/db/issues"
import { hasActiveIssueRun } from "@/lib/db/issue-runs"
import { IssueRunRefusedError, listIssueRunOptions, startIssueRun } from "@/lib/issues/run/registry"
import { issueRunOptionLabel, type IssueActionPayload, type IssueDraft } from "./card"
import { pushIssueCard, pushIssueRunChoice, pushIssueText, type IssueImPushDeps } from "./push"

export interface HandleIssueActionInput {
  binding: ConnectorCallbackBindingRow
  adapterId: string
  conversationKey?: string
  /** Who clicked; becomes the `by` actor on the trail. */
  user?: Pick<PlatformIdentity, "displayName" | "remoteUserId">
}

export interface IssueActionHandlerDeps {
  push?: Partial<IssueImPushDeps>
  audit: (entry: {
    adapterId: string
    kind: "issue.card_action" | "issue.card_action_denied"
    at: number
    conversationKey?: string
    reason?: string
    message?: string
    fields?: Record<string, unknown>
  }) => Promise<unknown>
  now: () => number
  /** Which workspace an IM-created issue lands in. */
  resolveWorkspaceId: () => Promise<string | null>
  /** Injected so the ambiguity card can be asserted without a transport. */
  pushRunChoice: typeof pushIssueRunChoice
}

async function defaultDeps(): Promise<IssueActionHandlerDeps> {
  const { appendAudit } = await import("@/lib/connectors/audit")
  return {
    audit: (entry) => appendAudit(entry as never),
    now: Date.now,
    pushRunChoice: pushIssueRunChoice,
    resolveWorkspaceId: async () => {
      const { useProjectStore } = await import("@/stores/project/project-store")
      const active = useProjectStore.getState().activeProjectId
      if (active) return active
      const { ensureDefaultProject } = await import("@/lib/db/project-scope")
      return (await ensureDefaultProject()).id
    },
  }
}

const STATUS_SET: ReadonlySet<string> = new Set(ISSUE_STATUSES)

/** Validate the binding payload; `null` for anything malformed. */
export function readIssueActionPayload(
  payload: Record<string, unknown> | undefined
): IssueActionPayload | null {
  if (!payload || typeof payload !== "object") return null
  const action = payload.action
  if (action === "move") {
    if (typeof payload.issueId !== "string" || !STATUS_SET.has(String(payload.to))) return null
    return { action, issueId: payload.issueId, to: payload.to as IssueStatus }
  }
  if (action === "run") {
    if (typeof payload.issueId !== "string") return null
    return {
      action,
      issueId: payload.issueId,
      // Only a choice card's buttons carry one. An unknown id is not silently
      // dropped here — the handler re-checks it against the live verdicts, so a
      // stale or forged id refuses rather than running the wrong engine.
      ...(typeof payload.adapterId === "string" && payload.adapterId
        ? { adapterId: payload.adapterId }
        : {}),
    }
  }
  if (action === "create") {
    const draft = payload.draft as Partial<IssueDraft> | undefined
    if (
      !draft ||
      typeof draft.draftId !== "string" ||
      typeof draft.title !== "string" ||
      !draft.title.trim() ||
      typeof payload.issueProjectId !== "string"
    ) {
      return null
    }
    return {
      action,
      issueProjectId: payload.issueProjectId,
      draft: {
        draftId: draft.draftId,
        title: draft.title,
        ...(typeof draft.description === "string" && draft.description
          ? { description: draft.description }
          : {}),
        ...(typeof draft.sourceMessageId === "string" && draft.sourceMessageId
          ? { sourceMessageId: draft.sourceMessageId }
          : {}),
      },
    }
  }
  if (action === "cancel_create") {
    if (typeof payload.draftId !== "string") return null
    return { action, draftId: payload.draftId }
  }
  return null
}

/**
 * Persist the conversation's default project (`ConversationOverrideRow.
 * issueProjectId`). `patchConversationOverride` needs an existing row or a
 * session id to mint one; resolve the bound session when there is no row yet.
 */
export async function rememberIssueProject(
  conversationKey: string,
  issueProjectId: string
): Promise<boolean> {
  try {
    await patchConversationOverride(conversationKey, { issueProjectId })
    return true
  } catch {
    try {
      const { findSessionByConversationKey } = await import("@/lib/connectors/session-bindings")
      const session = await findSessionByConversationKey(conversationKey)
      if (!session) return false
      await patchConversationOverride(conversationKey, { issueProjectId }, session.id)
      return true
    } catch {
      return false
    }
  }
}

/** The clicking human as an issue actor. */
export function actorFromUser(user: HandleIssueActionInput["user"]): IssueActor {
  return {
    kind: "human",
    ...(user?.remoteUserId ? { id: user.remoteUserId } : {}),
    ...(user?.displayName ? { label: user.displayName } : {}),
  }
}

/** Every binding on the same surface (the card's other buttons). */
export async function deleteSiblingBindings(adapterId: string, surfaceId: string): Promise<void> {
  const keys = await getDb()
    .connectorCallbackBindings.where("adapterId")
    .equals(adapterId)
    .filter((row) => row.surfaceId === surfaceId)
    .primaryKeys()
  if (keys.length === 0) return
  await getDb().connectorCallbackBindings.bulkDelete(keys as string[])
}

export type IssueActionOutcome =
  | { kind: "moved"; issue: Issue }
  | { kind: "move_denied"; reason: string }
  | { kind: "run_started"; issue: Issue; adapterId: string }
  | { kind: "run_refused"; reason: string }
  /** More than one engine could take it; the person was asked which. */
  | { kind: "run_choice"; adapterIds: string[] }
  | { kind: "created"; issue: Issue }
  | { kind: "create_cancelled" }
  | { kind: "ignored"; reason: string }

/**
 * Apply one `issue_action` click and reply. Never throws for a policy refusal
 * — the refusal is what gets replied. Engine failures propagate so the bus
 * audits them (mirrors the workflow approval branch).
 */
export async function handleIssueActionCallback(
  input: HandleIssueActionInput,
  overrides: Partial<IssueActionHandlerDeps> = {}
): Promise<IssueActionOutcome> {
  const deps: IssueActionHandlerDeps = { ...(await defaultDeps()), ...overrides }
  const payload = readIssueActionPayload(input.binding.payload)
  const conversationKey = input.conversationKey ?? input.binding.conversationKey
  if (!payload || !conversationKey) {
    // Malformed binding: clean the card up so it cannot keep misfiring.
    await deleteSiblingBindings(input.adapterId, input.binding.surfaceId)
    return { kind: "ignored", reason: payload ? "no-conversation" : "malformed-payload" }
  }
  const by = actorFromUser(input.user)
  const reply = (text: string, key: string) =>
    pushIssueText(
      { adapterId: input.adapterId, conversationKey, text, idempotencyKey: key },
      deps.push
    )
  const audit = (
    kind: "issue.card_action" | "issue.card_action_denied",
    fields: Record<string, unknown>,
    reason?: string
  ) =>
    deps.audit({
      adapterId: input.adapterId,
      kind,
      at: deps.now(),
      conversationKey,
      ...(reason ? { reason } : {}),
      fields: { action: payload.action, ...fields },
    })

  switch (payload.action) {
    case "move": {
      const runActive = await hasActiveIssueRun(payload.issueId)
      const denial = await moveIssue({ id: payload.issueId, to: payload.to, by, runActive })
      if (denial) {
        await audit(
          "issue.card_action_denied",
          { issueId: payload.issueId, to: payload.to },
          denial
        )
        await reply(
          `✗ Cannot move to ${payload.to}: ${denial}`,
          `issue-move-denied:${payload.issueId}:${deps.now()}`
        )
        return { kind: "move_denied", reason: denial }
      }
      const issue = (await getIssue(payload.issueId))!
      await audit("issue.card_action", { issueId: issue.id, to: payload.to })
      await pushIssueCard({ adapterId: input.adapterId, conversationKey, issue }, deps.push)
      return { kind: "moved", issue }
    }
    case "run": {
      const options = await listIssueRunOptions(payload.issueId)
      const runnable = options.filter((option) => option.verdict.ok)
      // A button that already names its engine was pressed on the choice card
      // below; the person, not registration order, picked it. Its verdict is
      // still re-checked here because the card may be minutes old.
      const chosen = payload.adapterId
        ? runnable.find((option) => option.adapter.id === payload.adapterId)
        : runnable.length === 1
          ? runnable[0]
          : undefined
      if (!chosen && payload.adapterId === undefined && runnable.length > 1) {
        // ▶ Run used to take the FIRST adapter that said yes. With one engine
        // registered that IS the only answer; with several it silently picked
        // on an ordering nobody chose and nothing displays. Ask instead — the
        // extra tap is spent only when the ambiguity is real.
        const issue = (await getIssue(payload.issueId))!
        await deps.pushRunChoice({
          adapterId: input.adapterId,
          conversationKey,
          issue,
          options: runnable.map((option) => ({
            id: option.adapter.id,
            label: issueRunOptionLabel({ id: option.adapter.id, kind: option.adapter.kind }),
          })),
        })
        await audit("issue.card_action", {
          issueId: payload.issueId,
          choices: runnable.map((option) => option.adapter.id),
        })
        return { kind: "run_choice", adapterIds: runnable.map((option) => option.adapter.id) }
      }
      const first = chosen
      if (!first) {
        const refused = options.find((option) => !option.verdict.ok)?.verdict
        const reason = refused && !refused.ok ? refused.reason : "adapter-missing"
        await audit("issue.card_action_denied", { issueId: payload.issueId }, reason)
        await reply(`✗ Cannot run: ${reason}`, `issue-run-refused:${payload.issueId}:${deps.now()}`)
        return { kind: "run_refused", reason }
      }
      try {
        await startIssueRun({
          issueId: payload.issueId,
          adapterId: first.adapter.id,
          by,
          origin: "im",
        })
      } catch (error) {
        if (error instanceof IssueRunRefusedError) {
          await audit("issue.card_action_denied", { issueId: payload.issueId }, error.reason)
          await reply(
            `✗ Cannot run: ${error.reason}`,
            `issue-run-refused:${payload.issueId}:${deps.now()}`
          )
          return { kind: "run_refused", reason: error.reason }
        }
        throw error
      }
      const issue = (await getIssue(payload.issueId))!
      await audit("issue.card_action", { issueId: issue.id, adapterId: first.adapter.id })
      await reply(
        `▶ ${issue.identifier} dispatched to ${first.adapter.id}`,
        `issue-run-started:${issue.id}:${deps.now()}`
      )
      await pushIssueCard({ adapterId: input.adapterId, conversationKey, issue }, deps.push)
      return { kind: "run_started", issue, adapterId: first.adapter.id }
    }
    case "create": {
      const workspaceId = await deps.resolveWorkspaceId()
      if (!workspaceId) {
        await deleteSiblingBindings(input.adapterId, input.binding.surfaceId)
        return { kind: "ignored", reason: "no-workspace" }
      }
      const issue = await createIssue({
        projectId: workspaceId,
        issueProjectId: payload.issueProjectId,
        title: payload.draft.title,
        ...(payload.draft.description ? { description: payload.draft.description } : {}),
        createdBy: by,
        origin: {
          kind: "im",
          conversationKey,
          ...(payload.draft.sourceMessageId ? { messageId: payload.draft.sourceMessageId } : {}),
        },
      })
      // Remember the choice so the next card preselects it. Best-effort: a
      // conversation with no override row and no bound session simply isn't
      // remembered — that must never fail the create.
      await rememberIssueProject(conversationKey, payload.issueProjectId)
      // Consume the confirmation card: one click files, the rest are dead.
      await deleteSiblingBindings(input.adapterId, input.binding.surfaceId)
      await audit("issue.card_action", { issueId: issue.id, draftId: payload.draft.draftId })
      await pushIssueCard({ adapterId: input.adapterId, conversationKey, issue }, deps.push)
      return { kind: "created", issue }
    }
    case "cancel_create": {
      await deleteSiblingBindings(input.adapterId, input.binding.surfaceId)
      await audit("issue.card_action", { draftId: payload.draftId })
      await reply("⊘ Not filed.", `issue-create-cancel:${payload.draftId}`)
      return { kind: "create_cancelled" }
    }
  }
}
