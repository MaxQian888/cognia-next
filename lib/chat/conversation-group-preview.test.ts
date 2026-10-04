import {
  applyTeamGroupPreviewCaps,
  CHATS_GROUP_PREVIEW_LIMIT,
  isChatsScopeGroup,
  SQUAD_GROUP_PREVIEW_LIMIT,
  teamGroupPreviewExpanded,
} from "@/lib/chat/conversation-group-preview"
import { UNGROUPED_ID, type ConversationSection } from "@/lib/chat/conversation-list-model"
import type { ChatSession } from "@cognia/agent-config-types"

function session(id: string, teamId?: string): ChatSession {
  return {
    id,
    workspaceId: "w-1",
    title: id,
    kind: teamId ? "team" : "direct",
    teamId: teamId ?? null,
    messages: [],
    createdAt: 1,
    updatedAt: 1,
  } as ChatSession
}

function teamGroup(id: string, count: number): Extract<ConversationSection, { kind: "group" }> {
  return {
    kind: "group",
    axis: "team",
    group: { id, name: id === UNGROUPED_ID ? "" : `team ${id}` },
    sessions: Array.from({ length: count }, (_, i) =>
      session(`${id}-s${i}`, id === UNGROUPED_ID ? undefined : id)
    ),
    collapsed: false,
  }
}

const EMPTY = new Set<string>()

describe("applyTeamGroupPreviewCaps", () => {
  it("caps a long squad group at the squad limit and annotates the hidden count", () => {
    const [section] = applyTeamGroupPreviewCaps([teamGroup("t-1", 8)], EMPTY)
    expect(section.kind).toBe("group")
    if (section.kind !== "group") return
    expect(section.sessions).toHaveLength(SQUAD_GROUP_PREVIEW_LIMIT)
    expect(section.previewHidden).toBe(8 - SQUAD_GROUP_PREVIEW_LIMIT)
  })

  it("shows the tail instead of a one-row expander", () => {
    const total = SQUAD_GROUP_PREVIEW_LIMIT + 1
    const [section] = applyTeamGroupPreviewCaps([teamGroup("t-1", total)], EMPTY)
    if (section.kind !== "group") throw new Error("expected group")
    expect(section.sessions).toHaveLength(total)
    expect(section.previewHidden).toBeUndefined()
  })

  it("lets the ungrouped Chats bucket preview more rows than a squad", () => {
    const [section] = applyTeamGroupPreviewCaps([teamGroup(UNGROUPED_ID, 9)], EMPTY)
    if (section.kind !== "group") throw new Error("expected group")
    expect(section.sessions).toHaveLength(CHATS_GROUP_PREVIEW_LIMIT)
    expect(section.previewHidden).toBe(9 - CHATS_GROUP_PREVIEW_LIMIT)
  })

  it("returns expanded and short groups untouched", () => {
    const short = teamGroup("t-1", 3)
    const expandedKey = "team:t-2"
    const [a, b] = applyTeamGroupPreviewCaps([short, teamGroup("t-2", 10)], new Set([expandedKey]))
    expect(a).toBe(short)
    expect((b as { previewHidden?: number }).previewHidden).toBeUndefined()
    if (b.kind === "group") expect(b.sessions).toHaveLength(10)
  })

  it("cuts a date-split group's runs at the preview row", () => {
    const rows = teamGroup("t-1", 8).sessions
    const split: ConversationSection = {
      ...teamGroup("t-1", 8),
      dateRuns: [
        { kind: "date", bucket: "today", scope: "team:t-1", sessions: rows.slice(0, 1) },
        { kind: "date", bucket: "yesterday", scope: "team:t-1", sessions: rows.slice(1, 5) },
        { kind: "date", bucket: "older", scope: "team:t-1", sessions: rows.slice(5) },
      ],
    }
    const [capped] = applyTeamGroupPreviewCaps([split], EMPTY)
    if (capped.kind !== "group") throw new Error("expected a group")
    expect(capped.sessions).toEqual(rows.slice(0, SQUAD_GROUP_PREVIEW_LIMIT))
    // Only the headers the preview rows sit under are drawn.
    expect(capped.dateRuns!.map((run) => [run.bucket, run.sessions.length])).toEqual([
      ["today", 1],
      ["yesterday", SQUAD_GROUP_PREVIEW_LIMIT - 1],
    ])
    expect(capped.previewHidden).toBe(8 - SQUAD_GROUP_PREVIEW_LIMIT)
  })

  it("never caps away the open conversation, and counts one row fewer behind the expander", () => {
    const chats = teamGroup(UNGROUPED_ID, 10)
    const open = chats.sessions[8]!
    const [section] = applyTeamGroupPreviewCaps([chats], EMPTY, open.id)
    if (section.kind !== "group") throw new Error("expected group")
    expect(section.sessions.map((s) => s.id)).toEqual([
      ...chats.sessions.slice(0, CHATS_GROUP_PREVIEW_LIMIT).map((s) => s.id),
      open.id,
    ])
    expect(section.previewHidden).toBe(10 - CHATS_GROUP_PREVIEW_LIMIT - 1)
  })

  it("caps as usual when the open conversation is already in the preview or elsewhere", () => {
    const squad = teamGroup("t-1", 8)
    const [inside] = applyTeamGroupPreviewCaps([squad], EMPTY, squad.sessions[0]!.id)
    const [elsewhere] = applyTeamGroupPreviewCaps([squad], EMPTY, "not-in-this-group")
    for (const section of [inside, elsewhere]) {
      if (section.kind !== "group") throw new Error("expected group")
      expect(section.sessions).toHaveLength(SQUAD_GROUP_PREVIEW_LIMIT)
      expect(section.previewHidden).toBe(8 - SQUAD_GROUP_PREVIEW_LIMIT)
    }
  })

  it("leaves non-team groups and non-group sections alone", () => {
    const otherAxis: ConversationSection = {
      kind: "group",
      axis: "workspace",
      group: { id: "w-1", name: "w" },
      sessions: Array.from({ length: 20 }, (_, i) => session(`w-s${i}`)),
      collapsed: false,
    }
    const recent: ConversationSection = { kind: "recent", sessions: [session("s")] }
    const [a, b] = applyTeamGroupPreviewCaps([otherAxis, recent], EMPTY)
    expect(a).toBe(otherAxis)
    expect(b).toBe(recent)
  })
})

describe("teamGroupPreviewExpanded / isChatsScopeGroup", () => {
  it("reports expansion only when the group outgrows its cap", () => {
    const longSquad = teamGroup("t-1", 12)
    const short = teamGroup("t-2", 2)
    const longChats = teamGroup(UNGROUPED_ID, 12)
    const expanded = new Set(["team:t-1", "team:t-2", `team:${UNGROUPED_ID}`])
    expect(teamGroupPreviewExpanded(longSquad, expanded)).toBe(true)
    expect(teamGroupPreviewExpanded(short, expanded)).toBe(false)
    expect(teamGroupPreviewExpanded(longSquad, EMPTY)).toBe(false)
    // The Chats bucket measures against its own (longer) cap.
    expect(teamGroupPreviewExpanded(longChats, expanded)).toBe(true)
    expect(
      teamGroupPreviewExpanded(
        teamGroup(UNGROUPED_ID, CHATS_GROUP_PREVIEW_LIMIT + 1),
        new Set([`team:${UNGROUPED_ID}`])
      )
    ).toBe(false)
  })

  it("identifies the Chats scope group", () => {
    expect(isChatsScopeGroup(teamGroup(UNGROUPED_ID, 0))).toBe(true)
    expect(isChatsScopeGroup(teamGroup("t-1", 0))).toBe(false)
    expect(isChatsScopeGroup({ kind: "recent", sessions: [] })).toBe(false)
  })
})
