/**
 * Tests for lib/connectors/commands/dispatch.ts — in-chat control commands.
 * All Dexie / enqueue deps are injected so the dispatcher runs in isolation.
 */

import { maybeHandleControlCommand, isCommandAllowed, type ControlCommandDeps } from "./dispatch"
import type { NormalizedInboundEvent, ChannelKind } from "@/types/connectors/event"
import type { AdapterInstanceRow, ConversationOverrideRow } from "@/lib/db/connector-types"
import type { ResolvedBinding } from "../policy-resolve"
import type { ChatSession } from "@/lib/claude/types"

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
    mentions: { mentionsSelf: false } as NormalizedInboundEvent["mentions"],
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
  deps: ControlCommandDeps
}

function harness(opts: { sessions?: ChatSession[]; active?: ChatSession } = {}): Harness {
  const enqueued: Harness["enqueued"] = []
  const audits: Harness["audits"] = []
  const patches: Harness["patches"] = []
  const created: ChatSession[] = []
  const sessions = opts.sessions ?? []
  const deps: ControlCommandDeps = {
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
  }
  return { enqueued, audits, patches, created, deps }
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

  it("/team <name> binds the team", async () => {
    const h = harness({ active: session("s1") })
    await maybeHandleControlCommand(
      makeEvent({ plainText: "/team Researchers" }),
      makeAdapter(),
      undefined,
      RESOLVED,
      h.deps
    )
    expect(h.patches[0].patch).toEqual({ teamId: "team_r" })
    expect(h.enqueued[0].text).toMatch(/Team bound: Researchers/)
  })

  it("/team off clears the binding", async () => {
    const h = harness({ active: session("s1") })
    await maybeHandleControlCommand(
      makeEvent({ plainText: "/team off" }),
      makeAdapter(),
      undefined,
      RESOLVED,
      h.deps
    )
    expect(h.patches[0].patch).toEqual({ teamId: undefined })
    expect(h.enqueued[0].text).toMatch(/Team unbound/)
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
