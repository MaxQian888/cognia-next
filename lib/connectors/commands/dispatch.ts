/**
 * Bus-level in-chat control-command dispatch (control-plane completion).
 *
 * Invoked by `ConnectorBus.dispatchInboundFull` at Step 9.5, right before the
 * help short-circuit. When the inbound message is a `/command`, it applies the
 * control action (switch model / mode / reasoning / character / team, manage
 * multi-session, or report status) and replies with a confirmation via
 * `enqueueOutbound`, returning `true` so the bus skips the AI turn AND the
 * workflow fan-out — the command text never becomes a stored user message.
 *
 * Permission model (`AdapterInstanceRow.controlCommands`): read-only commands
 * (`/help` `/status` `/sessions` `/dir`) are always allowed; state-changing
 * commands are gated by `mode` (everyone | private-only | allowlist). All Dexie
 * / enqueue dependencies are injectable for tests.
 */

import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { AdapterInstanceRow, ConversationOverrideRow } from "@/lib/db/connector-types"
import type { ConnectorMode } from "@/types/connectors/policy"
import type { ResolvedBinding } from "./../policy-resolve"
import type { ChatSession } from "@/lib/claude/types"
import { enqueueOutbound } from "@/lib/db/outbound-jobs"
import { appendAudit } from "@/lib/connectors/audit"
import { newIdempotencyKey } from "@/types/connectors/outbound"
import { patchConversationOverride } from "@/lib/db/conversation-overrides"
import {
  listSessionsByConversationKey,
  findActiveSessionForConversation,
  createPlatformSession,
} from "@/lib/connectors/session-bindings"
import { getCharacter, listCharacters } from "@/lib/db/characters"
import { resolveTeamByNameOrId } from "@/lib/connectors/team-dispatch"
import { resolveWorkflowByNameOrId } from "@/lib/workflow/library/lookup"
import { isBuiltInProviderId } from "@cognia/provider-types/built-in-provider-catalog"
import { parseControlCommand, isReadonlyCommand } from "./parse"
import * as R from "./render"

const CONNECTOR_MODES: ReadonlySet<string> = new Set<ConnectorMode>(["auto", "manual", "draft"])
const REASONING_LEVELS: ReadonlySet<string> = new Set(["low", "medium", "high", "xhigh", "max"])

export interface ControlCommandDeps {
  enqueue?: typeof enqueueOutbound
  audit?: typeof appendAudit
  now?: () => number
  patchOverride?: typeof patchConversationOverride
  listSessions?: typeof listSessionsByConversationKey
  findActiveSession?: typeof findActiveSessionForConversation
  createSession?: typeof createPlatformSession
  getCharacterById?: typeof getCharacter
  listAllCharacters?: typeof listCharacters
  resolveTeam?: typeof resolveTeamByNameOrId
  resolveWorkflow?: typeof resolveWorkflowByNameOrId
  /**
   * Validates a provider id for `/model <provider/model>`. Defaults to the
   * built-in catalog (60+ ids incl. all local/self-hosted); callers may inject
   * a richer validator that also accepts configured custom providers.
   */
  isKnownProvider?: (provider: string) => Promise<boolean>
}

function idPrefix(id: string): string {
  return id.slice(0, 8)
}

/**
 * Decide whether `sender` may run a state-changing command in this channel,
 * per the adapter's `controlCommands` policy. Read-only commands never reach
 * this check.
 */
export function isCommandAllowed(
  event: NormalizedInboundEvent,
  policy: AdapterInstanceRow["controlCommands"] | undefined
): boolean {
  const mode = policy?.mode ?? "private-only"
  if (mode === "everyone") return true
  const allow = policy?.allowedUserIds ?? []
  const inAllowlist = allow.includes(event.sender.id) || allow.includes(event.sender.remoteUserId)
  if (mode === "allowlist") return inAllowlist
  // private-only: allow in 1:1 DMs, else require the allowlist.
  return event.channel.kind === "private" || inAllowlist
}

/**
 * Handle an inbound control command. Returns `true` when the message was a
 * command (handled — bus skips AI + fan-out), `false` when it should flow on
 * as a normal message.
 */
export async function maybeHandleControlCommand(
  event: NormalizedInboundEvent,
  adapterRow: AdapterInstanceRow,
  override: ConversationOverrideRow | undefined,
  resolved: ResolvedBinding,
  deps: ControlCommandDeps = {}
): Promise<boolean> {
  // Only fresh user messages can be a command (mirrors the help dispatcher).
  if (event.kind && event.kind !== "create") return false

  const policy = adapterRow.controlCommands
  if (policy?.enabled === false) return false

  const parsed = parseControlCommand(event.plainText)
  if (parsed.kind === "not-a-command") return false

  const enqueue = deps.enqueue ?? enqueueOutbound
  const audit = deps.audit ?? appendAudit
  const at = (deps.now ?? Date.now)()
  const patchOverride = deps.patchOverride ?? patchConversationOverride
  const listSessions = deps.listSessions ?? listSessionsByConversationKey
  const findActiveSession = deps.findActiveSession ?? findActiveSessionForConversation
  const createSession = deps.createSession ?? createPlatformSession
  const getCharacterById = deps.getCharacterById ?? getCharacter
  const listAllCharacters = deps.listAllCharacters ?? listCharacters
  const resolveTeam = deps.resolveTeam ?? resolveTeamByNameOrId
  const resolveWorkflow = deps.resolveWorkflow ?? resolveWorkflowByNameOrId

  const reply = async (
    text: string,
    kind: "applied" | "denied" | "unknown",
    extraFields?: Record<string, unknown>
  ): Promise<void> => {
    await enqueue({
      adapterId: event.adapterId,
      conversationKey: event.conversationKey,
      request: {
        conversationRef: event.conversationRef,
        segments: [{ type: "text", text }],
        metadata: { idempotencyKey: newIdempotencyKey() },
      },
      source: "ai-run",
    })
    await audit({
      adapterId: event.adapterId,
      kind: `command.${kind}`,
      at,
      conversationKey: event.conversationKey,
      fields: { command: parsed.name, ...(extraFields ?? {}) },
    })
  }

  if (parsed.kind === "unknown") {
    await reply(R.renderUnknown(parsed.name), "unknown")
    return true
  }

  const { name, arg } = parsed

  // ── Permission gate for state-changing commands ──
  if (!isReadonlyCommand(name) && !isCommandAllowed(event, policy)) {
    await reply(R.renderDenied(), "denied")
    return true
  }

  // Lazily resolve / create the active session — state-changing commands need
  // an override row, which requires a sessionId when none exists yet.
  let active = await findActiveSession(event.conversationKey, override)
  const ensureSession = async (): Promise<ChatSession> => {
    if (!active) active = await createSession(event, resolved.characterId)
    return active
  }
  const persist = async (
    patch: Partial<Omit<ConversationOverrideRow, "id" | "conversationKey" | "createdAt">>
  ): Promise<void> => {
    const s = await ensureSession()
    await patchOverride(event.conversationKey, patch, s.id)
  }

  switch (name) {
    case "help":
      // `/help` belongs to the existing rich help-card dispatcher. Return
      // false (un-handled) so the bus falls through to `maybeHandleHelpCommand`
      // — no regression to the quick-commands / skills onboarding card.
      return false

    case "commands":
      await reply(R.renderHelp(), "applied")
      return true

    case "status": {
      const charId = override?.characterId ?? resolved.characterId
      const character = charId ? await getCharacterById(charId).catch(() => undefined) : undefined
      await reply(
        R.renderStatus({
          mode: override?.mode ?? resolved.mode,
          model: override?.modelOverride ?? "默认 / default",
          character: character?.name ?? "默认 / default",
          reasoning: override?.reasoningOverride ?? "默认 / default",
          approvalMode: override?.approvalMode ?? "prompt",
          team: override?.teamId ?? "无 / none",
          workflow: override?.workflowId ?? "无 / none",
          sessionTitle: active?.title ?? "无 / none",
          sessionIdPrefix: active ? idPrefix(active.id) : "—",
        }),
        "applied"
      )
      return true
    }

    case "sessions": {
      const sessions = await listSessions(event.conversationKey)
      const activeId = active?.id
      await reply(
        R.renderSessions(
          sessions.map((s) => ({
            title: s.title,
            idPrefix: idPrefix(s.id),
            active: s.id === activeId,
          }))
        ),
        "applied"
      )
      return true
    }

    case "dir": {
      const summary = active?.workingDir
        ? active.workingDir
        : "此会话未绑定本机目录 / no host directory bound to this conversation"
      await reply(R.renderDir(summary), "applied")
      return true
    }

    case "new": {
      const created = await createSession(event, resolved.characterId)
      active = created
      await patchOverride(event.conversationKey, { activeSessionId: created.id }, created.id)
      await reply(R.confirmNewSession(created.title, idPrefix(created.id)), "applied")
      return true
    }

    case "switch":
    case "resume": {
      if (!arg) {
        await reply(R.renderUsage("switch"), "applied")
        return true
      }
      const sessions = await listSessions(event.conversationKey)
      const target =
        sessions.find((s) => s.id === arg || s.id.startsWith(arg)) ??
        sessions.find((s) => s.title.toLowerCase().includes(arg.toLowerCase()))
      if (!target) {
        await reply(R.renderUsage("switch"), "applied")
        return true
      }
      await patchOverride(event.conversationKey, { activeSessionId: target.id }, target.id)
      active = target
      await reply(R.confirmSwitched(target.title, idPrefix(target.id)), "applied")
      return true
    }

    case "model": {
      if (!arg) {
        await reply(R.renderUsage("model"), "applied")
        return true
      }
      // Accept `provider/model` or a bare model id. Validate the PROVIDER
      // (when given) against the known set so a typo like `anthrpic/…`
      // doesn't silently persist a broken override. The MODEL is trusted —
      // the catalog's model list is a quick-add subset, not exhaustive, and
      // custom/self-hosted model ids are common.
      const slash = arg.indexOf("/")
      const provider = slash > 0 ? arg.slice(0, slash) : undefined
      const model = slash > 0 ? arg.slice(slash + 1) : arg
      if (!model) {
        await reply(R.renderUsage("model"), "applied")
        return true
      }
      if (provider) {
        const isKnown =
          deps.isKnownProvider ?? ((p: string) => Promise.resolve(isBuiltInProviderId(p)))
        if (!(await isKnown(provider))) {
          await reply(R.denyUnknownProvider(provider), "denied", {
            reason: "unknown_provider",
            provider,
          })
          return true
        }
      }
      await persist(
        provider ? { providerOverride: provider, modelOverride: model } : { modelOverride: model }
      )
      await reply(R.confirmModel(model, provider), "applied")
      return true
    }

    case "mode": {
      const v = arg.toLowerCase()
      if (v === "yolo" || v === "prompt") {
        await persist({ approvalMode: v })
        await reply(R.confirmApprovalMode(v), "applied")
        return true
      }
      if (CONNECTOR_MODES.has(v)) {
        await persist({ mode: v as ConnectorMode })
        await reply(R.confirmMode(v), "applied")
        return true
      }
      await reply(R.renderUsage("mode"), "applied")
      return true
    }

    case "reasoning": {
      const v = arg.toLowerCase()
      if (!REASONING_LEVELS.has(v)) {
        await reply(R.renderUsage("reasoning"), "applied")
        return true
      }
      await persist({ reasoningOverride: v as ConversationOverrideRow["reasoningOverride"] })
      await reply(R.confirmReasoning(v), "applied")
      return true
    }

    case "character": {
      if (!arg) {
        await reply(R.renderUsage("character"), "applied")
        return true
      }
      const byId = await getCharacterById(arg).catch(() => undefined)
      let match = byId
      if (!match) {
        const all = await listAllCharacters().catch(() => [])
        match = all.find((c) => c.name.toLowerCase() === arg.toLowerCase())
      }
      if (!match) {
        await reply(R.renderUsage("character"), "applied")
        return true
      }
      await persist({ characterId: match.id })
      await reply(R.confirmCharacter(match.name), "applied")
      return true
    }

    case "team": {
      if (!arg || arg.toLowerCase() === "off") {
        await persist({ teamId: undefined })
        await reply(R.confirmTeamCleared(), "applied")
        return true
      }
      const team = await resolveTeam(arg)
      if (!team) {
        await reply(R.renderUsage("team"), "applied")
        return true
      }
      await persist({ teamId: team.id })
      await reply(R.confirmTeam(team.name), "applied")
      return true
    }

    case "workflow": {
      if (!arg || arg.toLowerCase() === "off") {
        await persist({ workflowId: undefined })
        await reply(R.confirmWorkflowCleared(), "applied")
        return true
      }
      const res = await resolveWorkflow(arg)
      if (!res.ok) {
        if (res.reason === "ambiguous") {
          await reply(R.renderWorkflowAmbiguous(res.candidates), "applied")
          return true
        }
        await reply(R.renderUsage("workflow"), "applied")
        return true
      }
      await persist({ workflowId: res.workflowId })
      await reply(R.confirmWorkflow(res.name), "applied")
      return true
    }
  }

  // Exhaustive — every ControlCommandName is handled above.
  return assertNever(name)
}

function assertNever(x: never): never {
  throw new Error(`unhandled control command: ${String(x)}`)
}
