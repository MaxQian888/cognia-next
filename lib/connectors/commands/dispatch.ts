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
import type { MessageSegment } from "@/types/connectors/segment"
import type { AdapterInstanceRow, ConversationOverrideRow } from "@/lib/db/connector-types"
import type { ConnectorMode } from "@/types/connectors/policy"
import type { ResolvedBinding } from "./../policy-resolve"
import type { ChatSession } from "@cognia/agent-config-types"
import { enqueueGoverned as enqueueOutbound } from "@/lib/connectors/delivery-gateway"
import { appendAudit } from "@/lib/connectors/audit"
import { newIdempotencyKey } from "@/types/connectors/outbound"
import {
  patchConversationOverride,
  updateConversationConfigSection,
} from "@/lib/db/conversation-overrides"
import {
  listSessionsByConversationKey,
  findActiveSessionForConversation,
  createPlatformSession,
} from "@/lib/connectors/session-bindings"
import { getCharacter, listCharacters } from "@/lib/db/characters"
import { resolveTeamByNameOrId } from "@/lib/connectors/team-dispatch"
import { resolveWorkflowByNameOrId } from "@/lib/workflow/library/lookup"
import { resolveWorkflowDeployment } from "@/lib/db/workflow-deployments"
import { matchDispatchRule } from "@/lib/connectors/dispatch-rules"
import { resolveImEffectiveConfig } from "@/lib/connectors/effective-config"
import { isBuiltInProviderId } from "@cognia/provider-types/built-in-provider-catalog"
import { clearSessionBypass } from "@/lib/connectors/hitl/approval-registry"
import {
  closeConnectorConversation,
  getConnectorConversationState,
} from "@/lib/db/connector-conversation-state"
import { countPendingConnectorInboundJobs } from "@/lib/db/connector-inbound-jobs"
import { updateAdapterInstance } from "@/lib/db/adapter-instances"
import { getDb } from "@/lib/db/schema"
import {
  resolveDeliveryReadiness,
  resolveInboundActivationPolicy,
} from "@/lib/connectors/conversation-admission"
import { parseControlCommand, isReadonlyCommand } from "./parse"
import { handleGoalCommand } from "./goal"
import { handleScheduleCommand, type ScheduleCommandScheduler } from "./schedule"
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
  isWorkflowExecutable?: (workflowId: string) => Promise<boolean>
  /**
   * Validates a provider id for `/model <provider/model>`. Defaults to the
   * built-in catalog (60+ ids incl. all local/self-hosted); callers may inject
   * a richer validator that also accepts configured custom providers.
   */
  isKnownProvider?: (provider: string) => Promise<boolean>
  /** Injectable `/goal` handler (defaults to the real connector goal router). */
  handleGoal?: typeof handleGoalCommand
  scheduler?: ScheduleCommandScheduler
  getAgentTopicStatus?: (conversationKey: string) => Promise<
    R.AgentTopicStatusView & {
      activatedBy?: string
    }
  >
  closeAgentTopic?: typeof closeConnectorConversation
  updateAdapter?: typeof updateAdapterInstance
}

async function loadAgentTopicStatus(
  conversationKey: string,
  adapterRow: AdapterInstanceRow,
  override: ConversationOverrideRow | undefined,
  at: number
): Promise<R.AgentTopicStatusView & { activatedBy?: string }> {
  const db = getDb()
  const state = await getConnectorConversationState(conversationKey)
  const [queueDepth, bindings, recoveryCount] = await Promise.all([
    countPendingConnectorInboundJobs(conversationKey),
    db.executionRunBindings.where("conversationKey").equals(conversationKey).toArray(),
    db.connectorInboundJobs
      .where("conversationKey")
      .equals(conversationKey)
      .filter((job) => job.status === "recovery_required")
      .count(),
  ])
  const activeBinding = bindings.find((binding) => binding.status === "active")
  return {
    policy: resolveInboundActivationPolicy(adapterRow, override),
    active:
      state?.activationStatus === "active" &&
      (state.expiresAt === undefined || state.expiresAt > at),
    activatedBy: state?.activatedBy,
    expiresAt: state?.expiresAt,
    queueDepth,
    activeRunId: activeBinding?.runId,
    dispatchMode:
      state?.dispatchMode ??
      override?.activeRunDispatchMode ??
      adapterRow.activeRunDispatchMode ??
      "queue",
    readiness: resolveDeliveryReadiness(state?.deliveryReadiness, adapterRow.deliveryReadiness),
    recoveryCount,
  }
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

/** Strict allowlist membership used by high-impact control-plane writes. */
export function isSenderInCommandAllowlist(
  event: NormalizedInboundEvent,
  policy: AdapterInstanceRow["controlCommands"] | undefined
): boolean {
  const allow = policy?.allowedUserIds ?? []
  return allow.includes(event.sender.id) || allow.includes(event.sender.remoteUserId)
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
  const isWorkflowExecutable =
    deps.isWorkflowExecutable ??
    (async (workflowId: string) => Boolean(await resolveWorkflowDeployment(workflowId)))

  const reply = async (
    content: string | MessageSegment[],
    kind: "applied" | "denied" | "unknown",
    extraFields?: Record<string, unknown>
  ): Promise<void> => {
    await enqueue({
      adapterId: event.adapterId,
      conversationKey: event.conversationKey,
      request: {
        conversationRef: event.conversationRef,
        segments: typeof content === "string" ? [{ type: "text", text: content }] : content,
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
  // Scheduler writes always require explicit allowlist membership, even when
  // the adapter's general command mode is `everyone` or `private-only`.
  if (name === "schedule" && !isSenderInCommandAllowlist(event, policy)) {
    await reply(R.renderDenied(), "denied", { reason: "schedule_allowlist_required" })
    return true
  }
  if (name !== "agent" && !isReadonlyCommand(name) && !isCommandAllowed(event, policy)) {
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
    if (deps.patchOverride) {
      await patchOverride(event.conversationKey, patch, s.id)
      return
    }
    await updateConversationConfigSection({
      conversationKey: event.conversationKey,
      sessionId: s.id,
      section: "responder",
      patch,
      source: `command.${name}`,
    })
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
      const ruleHit = matchDispatchRule(adapterRow.dispatchRules, event)
      const effectiveConfig = resolveImEffectiveConfig({
        adapter: adapterRow,
        override: override ?? null,
        rule: ruleHit,
        system: { mode: resolved.mode, characterId: resolved.characterId },
      })
      const routing = effectiveConfig.routing
      const charId = override?.characterDisabled
        ? undefined
        : (routing.characterId ?? resolved.characterId)
      const character = charId ? await getCharacterById(charId).catch(() => undefined) : undefined
      // Effective values: per-conversation override first, then the BOT-level
      // instance default (annotated so the reader can tell them apart), then
      // the literal "default"/"none" fallback. Same resolver the runtime
      // dispatch uses, so `/status` can't drift from actual routing.
      const targetManaged = routing.teamId
        ? "由 Agent Team 管理 / managed by Agent Team"
        : routing.workflowId
          ? "由 Workflow 管理 / managed by Workflow"
          : undefined
      const botDefault = (v: string | undefined): string | undefined =>
        v?.trim() ? R.withBotDefault(v.trim()) : undefined
      const modelBinding = (value: string | undefined, source: string): string => {
        if (!value?.trim()) return "默认 / default"
        if (source === "adapter-default") return R.withBotDefault(value.trim())
        return R.withSource(value.trim(), source)
      }
      const routeSource = routing.teamId
        ? routing.teamSource
        : routing.workflowId
          ? routing.workflowSource
          : routing.characterId
            ? routing.characterSource
            : routing.respondViaAdapterId
              ? routing.respondViaSource
              : effectiveConfig.target.source
      const enabledRules = (adapterRow.dispatchRules ?? [])
        .filter((rule) => rule.enabled !== false)
        .map((rule, index) => R.renderDispatchRuleSummary(rule, index + 1))
      await reply(
        R.renderStatus({
          mode: override?.mode ?? resolved.mode,
          model:
            targetManaged ??
            modelBinding(effectiveConfig.model.effective, effectiveConfig.model.source),
          provider:
            targetManaged ??
            modelBinding(effectiveConfig.provider.effective, effectiveConfig.provider.source),
          character: override?.characterDisabled
            ? "已关闭 / none"
            : character?.name
              ? R.withSource(character.name, routing.characterSource)
              : "默认 / default",
          reasoning:
            override?.reasoningOverride ??
            botDefault(adapterRow.defaultReasoning) ??
            "默认 / default",
          approvalMode: override?.approvalMode ?? "prompt",
          team: routing.teamId
            ? routing.teamSource === "instance-default"
              ? R.withBotDefault(routing.teamId)
              : routing.teamSource === "rule"
                ? R.withSource(routing.teamId, routing.teamSource)
                : routing.teamId
            : override?.teamDisabled
              ? "已关闭 / off"
              : "无 / none",
          workflow: routing.workflowId
            ? R.withSource(routing.workflowId, routing.workflowSource)
            : override?.workflowDisabled
              ? "已关闭 / off"
              : "无 / none",
          routeSource: R.sourceLabel(routeSource),
          matchedRule: ruleHit
            ? ruleHit.rule.name?.trim()
              ? `${ruleHit.rule.name.trim()} (${ruleHit.rule.id})`
              : ruleHit.rule.id
            : "无 / none",
          responseAdapter: routing.respondViaAdapterId
            ? R.withSource(routing.respondViaAdapterId, routing.respondViaSource)
            : `${event.adapterId}（接收 Adapter / receiving adapter）`,
          enabledRules,
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
      const prior = active
      const created = await createSession(event, resolved.characterId)
      active = created
      await patchOverride(event.conversationKey, { activeSessionId: created.id }, created.id)
      // The conversation's session rotated — drop any "allow for session" tool
      // bypasses granted on the session we rotated away from, per the
      // approval-registry contract (a grant must not outlive its rotation).
      if (prior && prior.id !== created.id) clearSessionBypass(prior.id)
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
      // Session rotation — same bypass-drop contract as `/new` above.
      if (active && active.id !== target.id) clearSessionBypass(active.id)
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
      const normalized = arg.toLowerCase()
      if (normalized === "off" || normalized === "none") {
        await persist({ characterId: undefined, characterDisabled: true })
        await reply(R.confirmCharacterDisabled(), "applied")
        return true
      }
      if (normalized === "inherit") {
        await persist({ characterId: undefined, characterDisabled: undefined })
        await reply(R.confirmCharacterInherited(), "applied")
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
      await persist({ characterId: match.id, characterDisabled: undefined })
      await reply(R.confirmCharacter(match.name), "applied")
      return true
    }

    case "team": {
      if (!arg || arg.toLowerCase() === "off") {
        // `teamDisabled` is the explicit sentinel: with a bot-level
        // `defaultTeamId` in play, merely clearing `teamId` would silently
        // fall back to the bot default instead of turning teams off.
        await persist({ teamId: undefined, teamDisabled: true })
        await reply(
          adapterRow.defaultTeamId?.trim() ? R.confirmTeamDisabled() : R.confirmTeamCleared(),
          "applied"
        )
        return true
      }
      const team = await resolveTeam(arg)
      if (!team) {
        await reply(R.renderUsage("team"), "applied")
        return true
      }
      await persist({
        teamId: team.id,
        teamDisabled: undefined,
        workflowId: undefined,
        workflowDisabled: true,
      })
      await reply(R.confirmTeam(team.name), "applied")
      return true
    }

    case "workflow": {
      if (!arg || arg.toLowerCase() === "off") {
        await persist({ workflowId: undefined, workflowDisabled: true })
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
      if (!(await isWorkflowExecutable(res.workflowId))) {
        await reply(R.denyWorkflowNotDeployed(res.name), "denied", {
          reason: "workflow_not_deployed",
          workflowId: res.workflowId,
        })
        return true
      }
      await persist({
        workflowId: res.workflowId,
        workflowDisabled: undefined,
        teamId: undefined,
        teamDisabled: true,
      })
      await reply(R.confirmWorkflow(res.name), "applied")
      return true
    }

    case "goal": {
      // `/goal` has its own subcommand grammar + a headless driver, so it lives
      // in `commands/goal.ts`. It shares this scope's `reply` (confirmation +
      // audit) and `ensureSession` (the IM-bound session the guard checks).
      const handleGoal = deps.handleGoal ?? handleGoalCommand
      await handleGoal({ event, arg, ensureSession, reply })
      return true
    }

    case "tasks":
    case "schedule": {
      await handleScheduleCommand({
        name,
        arg,
        event,
        characterId: override?.characterId ?? resolved.characterId,
        reply,
        scheduler: deps.scheduler,
      })
      return true
    }

    case "agent": {
      const action = arg.trim().toLowerCase()
      const getStatus =
        deps.getAgentTopicStatus ??
        ((conversationKey: string) =>
          loadAgentTopicStatus(conversationKey, adapterRow, override, at))
      const status = await getStatus(event.conversationKey)

      if (action === "status") {
        await reply(R.renderAgentTopicStatus(status), "applied")
        return true
      }

      if (action === "off") {
        const isActivator =
          status.activatedBy === event.sender.id || status.activatedBy === event.sender.remoteUserId
        if (!isActivator && !isCommandAllowed(event, policy)) {
          await reply(R.renderDenied(), "denied", { reason: "agent_off_not_authorized" })
          return true
        }
        await (deps.closeAgentTopic ?? closeConnectorConversation)(event.conversationKey, {
          now: at,
        })
        await reply(R.confirmAgentOff(), "applied")
        return true
      }

      if (action === "verify") {
        if (!isCommandAllowed(event, policy)) {
          await reply(R.renderDenied(), "denied", { reason: "agent_verify_not_authorized" })
          return true
        }
        if (event.platform !== "lark" || event.channel.kind !== "group") {
          await reply(R.renderUsage("agent"), "denied", { reason: "probe_requires_lark_group" })
          return true
        }
        const expiresAt = at + 10 * 60 * 1000
        await (deps.updateAdapter ?? updateAdapterInstance)(adapterRow.id, {
          deliveryReadiness: "mentions_only",
          settings: {
            ...adapterRow.settings,
            unmentionedDeliveryProbe: {
              consoleConfirmed: true,
              startedAt: at,
              expiresAt,
            },
          },
        })
        await reply(R.confirmAgentProbeStarted(), "applied", { expiresAt })
        return true
      }

      await reply(R.renderUsage("agent"), "applied")
      return true
    }
  }

  // Exhaustive — every ControlCommandName is handled above.
  return assertNever(name)
}

function assertNever(x: never): never {
  throw new Error(`unhandled control command: ${String(x)}`)
}
