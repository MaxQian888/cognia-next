/**
 * Tests for lib/connectors/commands/dispatch.ts — in-chat control commands.
 * All Dexie / enqueue deps are injected so the dispatcher runs in isolation.
 */

import { maybeHandleControlCommand, isCommandAllowed, type ControlCommandDeps } from "./dispatch"
import type { NormalizedInboundEvent, ChannelKind } from "@/types/connectors/event"
import type { AdapterInstanceRow, ConversationOverrideRow } from "@/lib/db/connector-types"
import type { ResolvedBinding } from "../policy-resolve"
import type { ChatSession } from "@cognia/agent-config-types"
import {
  grantSessionBypass,
  hasSessionBypass,
  __resetApprovalRegistryForTesting,
} from "../hitl/approval-registry"

function makeEvent(over: Partial<NormalizedInboundEvent> = {}): NormalizedInboundEvent {
  return {
    platform: "telegram",
    adapterId: "tg-1",
    selfId: "bot",
    messageId: "m1",
    conversationRef: { platform: "telegram", adapterId: "tg-1" },
    conversationKey: "telegram:tg-1:42",
    sender: { id: "u1", remoteUserId: "u1", displayName: "Alice" },
    channel: { id: "c1", kind: "private" as ChannelKind, name: "Alice" },
    segments: [],
    plainText: "",
    mentions: { selfMentioned: false, users: [] } as NormalizedInboundEvent["mentions"],
    timestamp: 0,
    raw: {},
    ...over,
  } as NormalizedInboundEvent
}

function makeAdapter(over: Partial<AdapterInstanceRow> = {}): AdapterInstanceRow {
  return { id: "tg-1", controlCommands: undefined, ...over } as AdapterInstanceRow
}

const RESOLVED: ResolvedBinding = {
  mode: "auto",
  characterId: undefined,
  trigger: {} as ResolvedBinding["trigger"],
}

function session(id: string, title = id, workingDir?: string): ChatSession {
  return { id, title, kind: "direct", workingDir, createdAt: 0, updatedAt: 0 }
}

interface Harness {
  enqueued: Array<{ text: string }>
  audits: Array<{ kind: string; command?: unknown }>
  patches: Array<{ patch: Record<string, unknown>; sessionId?: string }>
  created: ChatSession[]
  goalCalls: Array<{ arg: string }>
  closedTopics: string[]
  adapterPatches: Array<Record<string, unknown>>
  deps: ControlCommandDeps
}

function harness(
  opts: {
    sessions?: ChatSession[]
    active?: ChatSession
    agentStatus?: Awaited<ReturnType<NonNullable<ControlCommandDeps["getAgentTopicStatus"]>>>
  } = {}
): Harness {
  const enqueued: Harness["enqueued"] = []
  const audits: Harness["audits"] = []
  const patches: Harness["patches"] = []
  const created: ChatSession[] = []
  const goalCalls: Harness["goalCalls"] = []
  const closedTopics: string[] = []
  const adapterPatches: Array<Record<string, unknown>> = []
  const sessions = opts.sessions ?? []
  const deps: ControlCommandDeps = {
    handleGoal: (async (inp: {
      arg: string
      reply: (t: string, k: "applied" | "denied" | "unknown") => Promise<void>
    }) => {
      goalCalls.push({ arg: inp.arg })
      await inp.reply("goal-ok", "applied")
    }) as unknown as ControlCommandDeps["handleGoal"],
    enqueue: (async (job: { request: { segments: Array<{ text?: string }> } }) => {
      enqueued.push({ text: job.request.segments.map((s) => s.text ?? "").join("") })
    }) as unknown as ControlCommandDeps["enqueue"],
    audit: (async (e: { kind: string; fields?: { command?: unknown } }) => {
      audits.push({ kind: e.kind, command: e.fields?.command })
    }) as unknown as ControlCommandDeps["audit"],
    now: () => 1000,
    patchOverride: (async (_key: string, patch: Record<string, unknown>, sessionId?: string) => {
      patches.push({ patch, sessionId })
      return {} as ConversationOverrideRow
    }) as unknown as ControlCommandDeps["patchOverride"],
    listSessions: (async () => sessions) as unknown as ControlCommandDeps["listSessions"],
    findActiveSession: (async () =>
      opts.active) as unknown as ControlCommandDeps["findActiveSession"],
    createSession: (async () => {
      const s = session(`new-${created.length}`, "New chat")
      created.push(s)
      return s
    }) as unknown as ControlCommandDeps["createSession"],
    getCharacterById: (async (id: string) =>
      id === "char_known"
        ? { id: "char_known", name: "Helper" }
        : undefined) as unknown as ControlCommandDeps["getCharacterById"],
    listAllCharacters: (async () => [
      { id: "char_known", name: "Helper" },
    ]) as unknown as ControlCommandDeps["listAllCharacters"],
    resolveTeam: (async (nameOrId: string) =>
      nameOrId === "Researchers" || nameOrId === "team_r"
        ? { id: "team_r", name: "Researchers" }
        : undefined) as unknown as ControlCommandDeps["resolveTeam"],
    resolveWorkflow: (async (nameOrId: string) => {
      if (nameOrId === "Nightly" || nameOrId === "wf_n")
        return { ok: true, workflowId: "wf_n", name: "Nightly" }
      if (nameOrId === "Many")
        return {
          ok: false,
          reason: "ambiguous",
          candidates: [
            { id: "wf_a", name: "Many A" },
            { id: "wf_b", name: "Many B" },
          ],
        }
      return { ok: false, reason: "not-found" }
    }) as unknown as ControlCommandDeps["resolveWorkflow"],
    isWorkflowExecutable: async () => true,
    getAgentTopicStatus: async () =>
      opts.agentStatus ?? {
        policy: "mention_activates",
        active: true,
        activatedBy: "activator",
        expiresAt: 86_401_000,
        queueDepth: 2,
        activeRunId: "run-1",
        dispatchMode: "queue",
        readiness: "mentions_only",
        recoveryCount: 1,
      },
    closeAgentTopic: (async (conversationKey: string) => {
      closedTopics.push(conversationKey)
      return undefined
    }) as ControlCommandDeps["closeAgentTopic"],
    updateAdapter: (async (_adapterId: string, patch: Record<string, unknown>) => {
      adapterPatches.push(patch)
    }) as ControlCommandDeps["updateAdapter"],
  }
  return { enqueued, audits, patches, created, goalCalls, closedTopics, adapterPatches, deps }
}

describe("isCommandAllowed", () => {
  it("everyone mode allows any sender/channel", () => {
    const e = makeEvent({
      channel: { id: "g", kind: "group" } as NormalizedInboundEvent["channel"],
    })
    expect(isCommandAllowed(e, { mode: "everyone" })).toBe(true)
  })
  it("private-only allows DMs, denies un-allowlisted group", () => {
    expect(isCommandAllowed(makeEvent(), { mode: "private-only" })).toBe(true)
    const g = makeEvent({
      channel: { id: "g", kind: "group" } as NormalizedInboundEvent["channel"],
    })
    expect(isCommandAllowed(g, { mode: "private-only" })).toBe(false)
    expect(isCommandAllowed(g, { mode: "private-only", allowedUserIds: ["u1"] })).toBe(true)
  })
  it("allowlist requires membership regardless of channel", () => {
    expect(isCommandAllowed(makeEvent(), { mode: "allowlist" })).toBe(false)
    expect(isCommandAllowed(makeEvent(), { mode: "allowlist", allowedUserIds: ["u1"] })).toBe(true)
  })
  it("defaults to private-only when no policy given", () => {
    expect(isCommandAllowed(makeEvent(), undefined)).toBe(true)
  })
})

describe("maybeHandleControlCommand", () => {
  it("requires explicit allowlist membership for /schedule even in everyone mode", async () => {
    const h = harness()
    await maybeHandleControlCommand(
      makeEvent({ plainText: "/schedule 5m summarize" }),
      makeAdapter({ controlCommands: { mode: "everyone" } }),
      undefined,
      RESOLVED,
      h.deps
    )
    expect(h.enqueued[0].text).toMatch(/not allowed/)
    expect(h.audits[0]).toEqual(
      expect.objectContaining({ kind: "command.denied", command: "schedule" })
    )
  })

  it("/agent status is readable by an ordinary topic participant", async () => {
    const h = harness()
    await maybeHandleControlCommand(
      makeEvent({
        platform: "lark",
        plainText: "/agent status",
        channel: { id: "oc-1", kind: "group" },
      }),
      makeAdapter({ controlCommands: { mode: "private-only" } }),
      undefined,
      RESOLVED,
      h.deps
    )
    expect(h.enqueued[0].text).toMatch(/mention_activates/)
    expect(h.enqueued[0].text).toMatch(/queue depth: 2/)
    expect(h.enqueued[0].text).toMatch(/run-1/)
  })

  it("/agent off allows the activator but denies an unrelated participant", async () => {
    const allowed = harness({
      agentStatus: {
        policy: "mention_activates",
        active: true,
        activatedBy: "u1",
        queueDepth: 0,
        dispatchMode: "queue",
        readiness: "mentions_only",
        recoveryCount: 0,
      },
    })
    const event = makeEvent({
      platform: "lark",
      plainText: "/agent off",
      channel: { id: "oc-1", kind: "group" },
    })
    await maybeHandleControlCommand(event, makeAdapter(), undefined, RESOLVED, allowed.deps)
    expect(allowed.closedTopics).toEqual([event.conversationKey])

    const denied = harness()
    await maybeHandleControlCommand(event, makeAdapter(), undefined, RESOLVED, denied.deps)
    expect(denied.closedTopics).toHaveLength(0)
    expect(denied.enqueued[0].text).toMatch(/not allowed/)
  })

  it("/agent verify starts a bounded Lark probe without pre-verifying readiness", async () => {
    const h = harness()
    await maybeHandleControlCommand(
      makeEvent({
        platform: "lark",
        plainText: "/agent verify",
        channel: { id: "oc-1", kind: "group" },
      }),
      makeAdapter({ controlCommands: { mode: "allowlist", allowedUserIds: ["u1"] } }),
      undefined,
      RESOLVED,
      h.deps
    )
    expect(h.adapterPatches[0]).toMatchObject({
      deliveryReadiness: "mentions_only",
      settings: {
        unmentionedDeliveryProbe: {
          consoleConfirmed: true,
          startedAt: 1000,
          expiresAt: 601000,
        },
      },
    })
  })

  it("returns false for a non-command message", async () => {
    const h = harness()
    const handled = await maybeHandleControlCommand(
      makeEvent({ plainText: "hello" }),
      makeAdapter(),
      undefined,
      RESOLVED,
      h.deps
    )
    expect(handled).toBe(false)
    expect(h.enqueued).toHaveLength(0)
  })

  it("returns false (no intercept) when controlCommands disabled", async () => {
    const h = harness()
    const handled = await maybeHandleControlCommand(
      makeEvent({ plainText: "/help" }),
      makeAdapter({ controlCommands: { enabled: false } }),
      undefined,
      RESOLVED,
      h.deps
    )
    expect(handled).toBe(false)
    expect(h.enqueued).toHaveLength(0)
  })

  it("replies to an unknown command", async () => {
    const h = harness()
    const handled = await maybeHandleControlCommand(
      makeEvent({ plainText: "/frobnicate" }),
      makeAdapter(),
      undefined,
      RESOLVED,
      h.deps
    )
    expect(handled).toBe(true)
    expect(h.enqueued[0].text).toMatch(/Unknown command/)
    expect(h.audits[0]).toEqual({ kind: "command.unknown", command: "frobnicate" })
  })

  it("defers /help to the rich help-card dispatcher (returns false)", async () => {
    const h = harness()
    const handled = await maybeHandleControlCommand(
      makeEvent({ plainText: "/help" }),
      makeAdapter(),
      undefined,
      RESOLVED,
      h.deps
    )
    expect(handled).toBe(false)
    expect(h.enqueued).toHaveLength(0)
  })

  it("serves /commands without a permission gate", async () => {
    const h = harness()
    await maybeHandleControlCommand(
      makeEvent({ plainText: "/commands" }),
      makeAdapter(),
      undefined,
      RESOLVED,
      h.deps
    )
    expect(h.enqueued[0].text).toMatch(/Available commands/)
    expect(h.audits[0].kind).toBe("command.applied")
  })

  it("applies /model in a private chat and persists modelOverride", async () => {
    const h = harness({ active: session("s1") })
    await maybeHandleControlCommand(
      makeEvent({ plainText: "/model gpt-5" }),
      makeAdapter(),
      undefined,
      RESOLVED,
      h.deps
    )
    expect(h.patches[0].patch).toEqual({ modelOverride: "gpt-5" })
    expect(h.enqueued[0].text).toMatch(/Model set: gpt-5/)
  })

  it("routes /goal (subcommand + arg) to the connector goal handler", async () => {
    const h = harness({ active: session("s1") })
    const handled = await maybeHandleControlCommand(
      makeEvent({ plainText: "/goal write a haiku" }),
      makeAdapter(),
      undefined,
      RESOLVED,
      h.deps
    )
    expect(handled).toBe(true)
    // The `/goal ` prefix is stripped; the remainder is the handler's arg.
    expect(h.goalCalls).toEqual([{ arg: "write a haiku" }])
    expect(h.enqueued.map((e) => e.text)).toContain("goal-ok")
  })

  it("denies /goal to an un-allowlisted group sender (state-changing gate)", async () => {
    const h = harness({ active: session("s1") })
    const handled = await maybeHandleControlCommand(
      makeEvent({
        plainText: "/goal do it",
        channel: { id: "c1", kind: "group" as ChannelKind, name: "Group" },
      }),
      makeAdapter({ controlCommands: { enabled: true, mode: "allowlist", allowedUserIds: [] } }),
      undefined,
      RESOLVED,
      h.deps
    )
    expect(handled).toBe(true)
    expect(h.goalCalls).toEqual([]) // never reached the goal handler
    expect(h.enqueued[0].text).toMatch(/not allowed|不允许|没有权限/)
  })

  it("splits provider/model for /model", async () => {
    const h = harness({ active: session("s1") })
    await maybeHandleControlCommand(
      makeEvent({ plainText: "/model anthropic/claude-opus-4-8" }),
      makeAdapter(),
      undefined,
      RESOLVED,
      h.deps
    )
    expect(h.patches[0].patch).toEqual({
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-8",
    })
  })

  it("denies /model with an unknown provider and does not persist", async () => {
    const h = harness({ active: session("s1") })
    const handled = await maybeHandleControlCommand(
      makeEvent({ plainText: "/model anthrpic/claude-x" }),
      makeAdapter(),
      undefined,
      RESOLVED,
      h.deps
    )
    expect(handled).toBe(true)
    expect(h.enqueued[0].text).toMatch(/Unknown provider/)
    expect(h.audits[0].kind).toBe("command.denied")
    expect(h.patches).toHaveLength(0)
  })

  it("accepts a custom provider when isKnownProvider is injected", async () => {
    const h = harness({ active: session("s1") })
    h.deps.isKnownProvider = async () => true
    await maybeHandleControlCommand(
      makeEvent({ plainText: "/model my-local-llm/llama3" }),
      makeAdapter(),
      undefined,
      RESOLVED,
      h.deps
    )
    expect(h.patches[0].patch).toEqual({
      providerOverride: "my-local-llm",
      modelOverride: "llama3",
    })
    expect(h.enqueued[0].text).toMatch(/Model set/)
  })

  it("refuses to guess when provider/model would repoint an already-bound channel", async () => {
    // `/model anthropic/claude-sonnet-4` on an OpenRouter-bound channel used to
    // pass the known-provider check and silently switch the whole channel to a
    // different vendor. Two readings, both plausible; on a connector channel a
    // silent misroute costs money in a currency nobody notices for a week.
    const h = harness({ active: session("s1") })
    const handled = await maybeHandleControlCommand(
      makeEvent({ plainText: "/model anthropic/claude-sonnet-4" }),
      makeAdapter({ defaultProvider: "openrouter" }),
      undefined,
      RESOLVED,
      h.deps
    )
    expect(handled).toBe(true)
    expect(h.patches).toHaveLength(0)
    expect(h.enqueued[0].text).toMatch(/Ambiguous argument/)
    expect(h.audits[0].kind).toBe("command.denied")
  })

  it("accepts the unambiguous provider:model form", async () => {
    const h = harness({ active: session("s1") })
    await maybeHandleControlCommand(
      makeEvent({ plainText: "/model anthropic:claude-sonnet-4" }),
      makeAdapter({ defaultProvider: "openrouter" }),
      undefined,
      RESOLVED,
      h.deps
    )
    expect(h.patches[0].patch).toEqual({
      providerOverride: "anthropic",
      modelOverride: "claude-sonnet-4",
    })
  })

  it("still sets provider/model when the channel is not bound to another provider", async () => {
    const h = harness({ active: session("s1") })
    await maybeHandleControlCommand(
      makeEvent({ plainText: "/model anthropic/claude-opus-4-8" }),
      makeAdapter(),
      undefined,
      RESOLVED,
      h.deps
    )
    expect(h.patches[0].patch).toEqual({
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-8",
    })
  })

  it("denies a state-changing command from an un-allowlisted group sender", async () => {
    const h = harness({ active: session("s1") })
    const handled = await maybeHandleControlCommand(
      makeEvent({
        plainText: "/model gpt-5",
        channel: { id: "g", kind: "group" } as NormalizedInboundEvent["channel"],
      }),
      makeAdapter({ controlCommands: { mode: "private-only" } }),
      undefined,
      RESOLVED,
      h.deps
    )
    expect(handled).toBe(true)
    expect(h.enqueued[0].text).toMatch(/not allowed/)
    expect(h.audits[0].kind).toBe("command.denied")
    expect(h.patches).toHaveLength(0)
  })

  it("sets connector mode via /mode auto", async () => {
    const h = harness({ active: session("s1") })
    await maybeHandleControlCommand(
      makeEvent({ plainText: "/mode manual" }),
      makeAdapter(),
      undefined,
      RESOLVED,
      h.deps
    )
    expect(h.patches[0].patch).toEqual({ mode: "manual" })
  })

  it("sets approvalMode via /mode yolo", async () => {
    const h = harness({ active: session("s1") })
    await maybeHandleControlCommand(
      makeEvent({ plainText: "/mode yolo" }),
      makeAdapter(),
      undefined,
      RESOLVED,
      h.deps
    )
    expect(h.patches[0].patch).toEqual({ approvalMode: "yolo" })
  })

  it("rejects an invalid /mode with a usage hint and no mutation", async () => {
    const h = harness({ active: session("s1") })
    await maybeHandleControlCommand(
      makeEvent({ plainText: "/mode bogus" }),
      makeAdapter(),
      undefined,
      RESOLVED,
      h.deps
    )
    expect(h.patches).toHaveLength(0)
    expect(h.enqueued[0].text).toMatch(/Usage/)
  })

  it("sets reasoning via /reasoning high; rejects invalid", async () => {
    const ok = harness({ active: session("s1") })
    await maybeHandleControlCommand(
      makeEvent({ plainText: "/reasoning high" }),
      makeAdapter(),
      undefined,
      RESOLVED,
      ok.deps
    )
    expect(ok.patches[0].patch).toEqual({ reasoningOverride: "high" })

    const bad = harness({ active: session("s1") })
    await maybeHandleControlCommand(
      makeEvent({ plainText: "/reasoning ultra" }),
      makeAdapter(),
      undefined,
      RESOLVED,
      bad.deps
    )
    expect(bad.patches).toHaveLength(0)
  })

  it("switches character by name", async () => {
    const h = harness({ active: session("s1") })
    await maybeHandleControlCommand(
      makeEvent({ plainText: "/character Helper" }),
      makeAdapter(),
      undefined,
      RESOLVED,
      h.deps
    )
    expect(h.patches[0].patch).toEqual({ characterId: "char_known" })
    expect(h.enqueued[0].text).toMatch(/Character set: Helper/)
  })

  it("rejects an unknown character with a usage hint", async () => {
    const h = harness({ active: session("s1") })
    await maybeHandleControlCommand(
      makeEvent({ plainText: "/character Ghost" }),
      makeAdapter(),
      undefined,
      RESOLVED,
      h.deps
    )
    expect(h.patches).toHaveLength(0)
    expect(h.enqueued[0].text).toMatch(/Usage/)
  })

  it("supports Character None and Inherit without changing Adapter defaults", async () => {
    const none = harness({ active: session("s1") })
    await maybeHandleControlCommand(
      makeEvent({ plainText: "/character none" }),
      makeAdapter({ defaultCharacterId: "char_known" }),
      undefined,
      RESOLVED,
      none.deps
    )
    expect(none.patches[0].patch).toEqual({ characterId: undefined, characterDisabled: true })

    const inherit = harness({ active: session("s1") })
    await maybeHandleControlCommand(
      makeEvent({ plainText: "/character inherit" }),
      makeAdapter({ defaultCharacterId: "char_known" }),
      { characterDisabled: true } as ConversationOverrideRow,
      RESOLVED,
      inherit.deps
    )
    expect(inherit.patches[0].patch).toEqual({
      characterId: undefined,
      characterDisabled: undefined,
    })
  })

  it("/new creates a session and points activeSessionId at it", async () => {
    const h = harness()
    await maybeHandleControlCommand(
      makeEvent({ plainText: "/new" }),
      makeAdapter(),
      undefined,
      RESOLVED,
      h.deps
    )
    expect(h.created).toHaveLength(1)
    expect(h.patches[0].patch).toEqual({ activeSessionId: h.created[0].id })
    expect(h.enqueued[0].text).toMatch(/New session/)
  })

  it("/switch <id-prefix> sets the active session", async () => {
    const h = harness({ sessions: [session("abc12345", "Old"), session("def67890", "Newer")] })
    await maybeHandleControlCommand(
      makeEvent({ plainText: "/switch def67890" }),
      makeAdapter(),
      undefined,
      RESOLVED,
      h.deps
    )
    expect(h.patches[0].patch).toEqual({ activeSessionId: "def67890" })
    expect(h.enqueued[0].text).toMatch(/Switched to: Newer/)
  })

  it("/switch with no match returns a usage hint", async () => {
    const h = harness({ sessions: [session("abc12345", "Old")] })
    await maybeHandleControlCommand(
      makeEvent({ plainText: "/switch zzz" }),
      makeAdapter(),
      undefined,
      RESOLVED,
      h.deps
    )
    expect(h.patches).toHaveLength(0)
    expect(h.enqueued[0].text).toMatch(/Usage/)
  })

  it("/sessions lists bound sessions and marks the active one", async () => {
    const sessions = [session("abc12345", "First"), session("def67890", "Second")]
    const h = harness({ sessions, active: sessions[1] })
    await maybeHandleControlCommand(
      makeEvent({ plainText: "/sessions" }),
      makeAdapter(),
      undefined,
      RESOLVED,
      h.deps
    )
    expect(h.enqueued[0].text).toMatch(/First/)
    expect(h.enqueued[0].text).toMatch(/Second/)
    expect(h.enqueued[0].text).toMatch(/active/)
  })

  it("/status reports effective settings from the override", async () => {
    const h = harness({ active: session("s1", "Main") })
    const override = {
      modelOverride: "gpt-5",
      reasoningOverride: "high",
      approvalMode: "yolo",
      mode: "manual",
    } as ConversationOverrideRow
    await maybeHandleControlCommand(
      makeEvent({ plainText: "/status" }),
      makeAdapter(),
      override,
      RESOLVED,
      h.deps
    )
    const text = h.enqueued[0].text
    expect(text).toMatch(/gpt-5/)
    expect(text).toMatch(/high/)
    expect(text).toMatch(/yolo/)
    expect(text).toMatch(/Main/)
  })

  it("/status shows the assignee and labels assignment-written routing (slice 1A)", async () => {
    const h = harness({ active: session("s1", "Main") })
    const override = {
      teamId: "team_r",
      characterId: "char_known",
      routingSource: "assignment",
      assignee: { kind: "team", id: "team_r", label: "Researchers" },
      assigneeKind: "team",
    } as ConversationOverrideRow
    await maybeHandleControlCommand(
      makeEvent({ plainText: "/status" }),
      makeAdapter(),
      override,
      RESOLVED,
      h.deps
    )
    const text = h.enqueued[0].text
    expect(text).toMatch(/source: 会话分配 \/ assignment/)
    expect(text).toMatch(/team: team_r（会话分配 \/ assignment）/)
    expect(text).toMatch(/character: Helper（会话分配 \/ assignment）/)
    expect(text).toMatch(/assignee: 团队 \/ team: Researchers/)
  })

  it("/character, /team and /mode drop the assignment routing marker (slice 1A)", async () => {
    const marker = {
      routingSource: undefined,
      assignmentPreviousMode: undefined,
      assignmentPreviousRouting: undefined,
    }
    const cases: Array<[string, Record<string, unknown>]> = [
      ["/character Helper", { characterId: "char_known", characterDisabled: undefined }],
      ["/character off", { characterId: undefined, characterDisabled: true }],
      ["/character inherit", { characterId: undefined, characterDisabled: undefined }],
      [
        "/team Researchers",
        {
          teamId: "team_r",
          teamDisabled: undefined,
          workflowId: undefined,
          workflowDisabled: true,
        },
      ],
      ["/team off", { teamId: undefined, teamDisabled: true }],
      ["/mode draft", { mode: "draft" }],
    ]
    for (const [text, expected] of cases) {
      const h = harness({ active: session("s1") })
      await maybeHandleControlCommand(
        makeEvent({ plainText: text }),
        makeAdapter(),
        undefined,
        RESOLVED,
        h.deps
      )
      expect(h.patches).toHaveLength(1)
      // The marker keys are present (explicitly undefined) so the merge in
      // `updateConversationConfigSection` overwrites a stale marker.
      expect(Object.keys(h.patches[0].patch)).toEqual(expect.arrayContaining(Object.keys(marker)))
      expect(h.patches[0].patch).toEqual({ ...expected, ...marker })
    }
    // `/mode yolo` edits approval, not routing — no marker.
    const h = harness({ active: session("s1") })
    await maybeHandleControlCommand(
      makeEvent({ plainText: "/mode yolo" }),
      makeAdapter(),
      undefined,
      RESOLVED,
      h.deps
    )
    expect(Object.keys(h.patches[0].patch)).toEqual(["approvalMode"])
  })

  it("/status surfaces bot-instance defaults (annotated) when no override is set", async () => {
    const h = harness({ active: session("s1", "Main") })
    await maybeHandleControlCommand(
      makeEvent({ plainText: "/status" }),
      makeAdapter({
        defaultTeamId: "team_bot",
        defaultModel: "claude-fable-5",
        defaultProvider: "anthropic",
        defaultReasoning: "high",
      }),
      undefined,
      RESOLVED,
      h.deps
    )
    const text = h.enqueued[0].text
    expect(text).toMatch(/model: 由 Agent Team 管理 \/ managed by Agent Team/)
    expect(text).toMatch(/provider: 由 Agent Team 管理 \/ managed by Agent Team/)
    expect(text).toMatch(/reasoning: high（bot 默认 \/ bot default）/)
    expect(text).toMatch(/team: team_bot（bot 默认 \/ bot default）/)
  })

  it("/status annotates direct model bindings with their effective source", async () => {
    const h = harness({ active: session("s1", "Main") })
    await maybeHandleControlCommand(
      makeEvent({ plainText: "/status" }),
      makeAdapter({ defaultModel: "bot-model", defaultProvider: "openai" }),
      undefined,
      RESOLVED,
      h.deps
    )
    expect(h.enqueued[0].text).toMatch(/model: bot-model（bot 默认 \/ bot default）/)
    expect(h.enqueued[0].text).toMatch(/provider: openai（bot 默认 \/ bot default）/)
  })

  it("/status shows team off (not the bot default) when teamDisabled is set", async () => {
    const h = harness({ active: session("s1", "Main") })
    await maybeHandleControlCommand(
      makeEvent({ plainText: "/status" }),
      makeAdapter({ defaultTeamId: "team_bot" }),
      { teamDisabled: true } as ConversationOverrideRow,
      RESOLVED,
      h.deps
    )
    expect(h.enqueued[0].text).toMatch(/team: 已关闭 \/ off/)
  })

  it("/status prefers the conversation override over the bot default", async () => {
    const h = harness({ active: session("s1", "Main") })
    await maybeHandleControlCommand(
      makeEvent({ plainText: "/status" }),
      makeAdapter({ defaultModel: "bot-model", defaultTeamId: "team_bot" }),
      { modelOverride: "gpt-5", teamId: "team_chat" } as ConversationOverrideRow,
      RESOLVED,
      h.deps
    )
    const text = h.enqueued[0].text
    expect(text).toMatch(/model: 由 Agent Team 管理 \/ managed by Agent Team/)
    expect(text).toMatch(/team: team_chat\n/)
    expect(text).not.toMatch(/bot-model|gpt-5/)
  })

  it("/status reports the rule matched by the current event and enabled rule priority", async () => {
    const h = harness({ active: session("s1", "Main") })
    await maybeHandleControlCommand(
      makeEvent({ plainText: "/status" }),
      makeAdapter({
        defaultModel: "bot-model",
        dispatchRules: [
          {
            id: "rule-status",
            name: "Status route",
            match: { keywords: ["/status"] },
            action: { teamId: "team_status", respondViaAdapterId: "tg-reply" },
          },
          {
            id: "rule-future",
            name: "Future route",
            match: { keywords: ["urgent"] },
            action: { workflowId: "wf_future" },
          },
          {
            id: "rule-disabled",
            enabled: false,
            name: "Disabled route",
            match: {},
            action: { characterId: "char_known" },
          },
        ],
      }),
      undefined,
      RESOLVED,
      h.deps
    )

    const text = h.enqueued[0].text
    expect(text).toMatch(/matched rule: Status route \(rule-status\)/)
    expect(text).toMatch(/source: 路由规则 \/ dispatch rule/)
    expect(text).toMatch(/team: team_status（路由规则 \/ dispatch rule）/)
    expect(text).toMatch(/response adapter: tg-reply（路由规则 \/ dispatch rule）/)
    expect(text).toMatch(/model: 由 Agent Team 管理 \/ managed by Agent Team/)
    expect(text).not.toMatch(/bot-model/)
    expect(text.indexOf("Status route")).toBeLessThan(text.indexOf("Future route"))
    expect(text).not.toMatch(/Disabled route/)
    expect(text).toMatch(/Future messages are matched again/)
  })

  it("/status says no rule matched when enabled rules do not match /status", async () => {
    const h = harness({ active: session("s1", "Main") })
    await maybeHandleControlCommand(
      makeEvent({ plainText: "/status" }),
      makeAdapter({
        dispatchRules: [
          {
            id: "rule-urgent",
            name: "Urgent route",
            match: { keywords: ["urgent"] },
            action: { characterId: "char_known" },
          },
        ],
      }),
      undefined,
      RESOLVED,
      h.deps
    )

    expect(h.enqueued[0].text).toMatch(/matched rule: 无 \/ none/)
    expect(h.enqueued[0].text).toMatch(/response adapter: tg-1/)
    expect(h.enqueued[0].text).toMatch(/Urgent route/)
  })

  it("/team <name> binds the team", async () => {
    const h = harness({ active: session("s1") })
    await maybeHandleControlCommand(
      makeEvent({ plainText: "/team Researchers" }),
      makeAdapter(),
      undefined,
      RESOLVED,
      h.deps
    )
    expect(h.patches[0].patch).toEqual({
      teamId: "team_r",
      teamDisabled: undefined,
      workflowId: undefined,
      workflowDisabled: true,
    })
    expect(h.enqueued[0].text).toMatch(/Team bound: Researchers/)
  })

  it("/team off clears the binding and sets the teamDisabled sentinel", async () => {
    const h = harness({ active: session("s1") })
    await maybeHandleControlCommand(
      makeEvent({ plainText: "/team off" }),
      makeAdapter(),
      undefined,
      RESOLVED,
      h.deps
    )
    expect(h.patches[0].patch).toEqual({ teamId: undefined, teamDisabled: true })
    expect(h.enqueued[0].text).toMatch(/Team unbound/)
  })

  it("/team off on a bot with a defaultTeamId announces that the bot default is also off", async () => {
    const h = harness({ active: session("s1") })
    await maybeHandleControlCommand(
      makeEvent({ plainText: "/team off" }),
      makeAdapter({ defaultTeamId: "team_bot" }),
      undefined,
      RESOLVED,
      h.deps
    )
    expect(h.patches[0].patch).toEqual({ teamId: undefined, teamDisabled: true })
    expect(h.enqueued[0].text).toMatch(/包括机器人默认团队|including the bot default/)
  })

  it("/dir reports the working-context summary", async () => {
    const h = harness({ active: session("s1", "Main", "/work/repo") })
    await maybeHandleControlCommand(
      makeEvent({ plainText: "/dir" }),
      makeAdapter(),
      undefined,
      RESOLVED,
      h.deps
    )
    expect(h.enqueued[0].text).toMatch(/\/work\/repo/)
    expect(h.audits[0].kind).toBe("command.applied")
  })

  it("/dir notes when no host directory is bound", async () => {
    const h = harness({ active: session("s1", "Main") })
    await maybeHandleControlCommand(
      makeEvent({ plainText: "/dir" }),
      makeAdapter(),
      undefined,
      RESOLVED,
      h.deps
    )
    expect(h.enqueued[0].text).toMatch(/no host directory/)
  })

  it("/team with an unknown name returns a usage hint", async () => {
    const h = harness({ active: session("s1") })
    await maybeHandleControlCommand(
      makeEvent({ plainText: "/team Ghosts" }),
      makeAdapter(),
      undefined,
      RESOLVED,
      h.deps
    )
    expect(h.patches).toHaveLength(0)
    expect(h.enqueued[0].text).toMatch(/Usage/)
  })

  it("/workflow <name> binds the workflow", async () => {
    const h = harness({ active: session("s1") })
    await maybeHandleControlCommand(
      makeEvent({ plainText: "/workflow Nightly" }),
      makeAdapter(),
      undefined,
      RESOLVED,
      h.deps
    )
    expect(h.patches[0].patch).toEqual({
      workflowId: "wf_n",
      workflowDisabled: undefined,
      teamId: undefined,
      teamDisabled: true,
    })
    expect(h.enqueued[0].text).toMatch(/Workflow bound: Nightly/)
    expect(h.audits[0].kind).toBe("command.applied")
  })

  it("/workflow <id> binds by id", async () => {
    const h = harness({ active: session("s1") })
    await maybeHandleControlCommand(
      makeEvent({ plainText: "/workflow wf_n" }),
      makeAdapter(),
      undefined,
      RESOLVED,
      h.deps
    )
    expect(h.patches[0].patch).toEqual({
      workflowId: "wf_n",
      workflowDisabled: undefined,
      teamId: undefined,
      teamDisabled: true,
    })
  })

  it("/workflow off clears the binding", async () => {
    const h = harness({ active: session("s1") })
    await maybeHandleControlCommand(
      makeEvent({ plainText: "/workflow off" }),
      makeAdapter(),
      undefined,
      RESOLVED,
      h.deps
    )
    expect(h.patches[0].patch).toEqual({ workflowId: undefined, workflowDisabled: true })
    expect(h.enqueued[0].text).toMatch(/Workflow disabled/)
  })

  it("/workflow with an ambiguous name lists candidates", async () => {
    const h = harness({ active: session("s1") })
    await maybeHandleControlCommand(
      makeEvent({ plainText: "/workflow Many" }),
      makeAdapter(),
      undefined,
      RESOLVED,
      h.deps
    )
    expect(h.patches).toHaveLength(0)
    expect(h.enqueued[0].text).toMatch(/Many A/)
    expect(h.enqueued[0].text).toMatch(/Many B/)
  })

  it("/workflow with an unknown name returns a usage hint", async () => {
    const h = harness({ active: session("s1") })
    await maybeHandleControlCommand(
      makeEvent({ plainText: "/workflow Ghost" }),
      makeAdapter(),
      undefined,
      RESOLVED,
      h.deps
    )
    expect(h.patches).toHaveLength(0)
    expect(h.enqueued[0].text).toMatch(/Usage/)
  })

  it("rejects a Workflow without an active production deployment", async () => {
    const h = harness({ active: session("s1") })
    h.deps.isWorkflowExecutable = async () => false
    await maybeHandleControlCommand(
      makeEvent({ plainText: "/workflow Nightly" }),
      makeAdapter(),
      undefined,
      RESOLVED,
      h.deps
    )
    expect(h.patches).toHaveLength(0)
    expect(h.enqueued[0].text).toMatch(/no active production deployment/)
    expect(h.audits[0]).toMatchObject({ kind: "command.denied" })
  })

  it("/status shows the bound workflow", async () => {
    const h = harness({ active: session("s1") })
    await maybeHandleControlCommand(
      makeEvent({ plainText: "/status" }),
      makeAdapter(),
      { workflowId: "wf_n" } as ConversationOverrideRow,
      RESOLVED,
      h.deps
    )
    expect(h.enqueued[0].text).toMatch(/workflow: wf_n/)
  })

  it("does not intercept edit/delete/system events", async () => {
    const h = harness()
    const handled = await maybeHandleControlCommand(
      makeEvent({ plainText: "/help", kind: "edit" }),
      makeAdapter(),
      undefined,
      RESOLVED,
      h.deps
    )
    expect(handled).toBe(false)
  })
})

describe("session rotation drops HITL session bypasses", () => {
  beforeEach(() => {
    __resetApprovalRegistryForTesting()
  })

  it("/new clears the prior active session's bypass set", async () => {
    grantSessionBypass("old-1", "Bash")
    const h = harness({ active: session("old-1") })
    await maybeHandleControlCommand(
      makeEvent({ plainText: "/new" }),
      makeAdapter(),
      undefined,
      RESOLVED,
      h.deps
    )
    expect(hasSessionBypass("old-1", "Bash")).toBe(false)
  })

  it("/new with no prior session clears nothing (no rotation happened)", async () => {
    grantSessionBypass("unrelated", "Bash")
    const h = harness()
    await maybeHandleControlCommand(
      makeEvent({ plainText: "/new" }),
      makeAdapter(),
      undefined,
      RESOLVED,
      h.deps
    )
    expect(hasSessionBypass("unrelated", "Bash")).toBe(true)
  })

  it("/switch clears the previously active session's bypass but keeps the target's", async () => {
    grantSessionBypass("abc12345", "Bash")
    grantSessionBypass("def67890", "Bash")
    const h = harness({
      sessions: [session("abc12345", "Old"), session("def67890", "Newer")],
      active: session("abc12345", "Old"),
    })
    await maybeHandleControlCommand(
      makeEvent({ plainText: "/switch def67890" }),
      makeAdapter(),
      undefined,
      RESOLVED,
      h.deps
    )
    expect(hasSessionBypass("abc12345", "Bash")).toBe(false)
    expect(hasSessionBypass("def67890", "Bash")).toBe(true)
  })

  it("/switch to the already-active session keeps its bypass (no rotation)", async () => {
    grantSessionBypass("abc12345", "Bash")
    const h = harness({
      sessions: [session("abc12345", "Only")],
      active: session("abc12345", "Only"),
    })
    await maybeHandleControlCommand(
      makeEvent({ plainText: "/switch abc12345" }),
      makeAdapter(),
      undefined,
      RESOLVED,
      h.deps
    )
    expect(hasSessionBypass("abc12345", "Bash")).toBe(true)
  })
})
