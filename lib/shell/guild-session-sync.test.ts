import type { ChatSession } from "@/lib/claude/types"
import type { SelectedGuild } from "@/stores/ui"
import {
  guildKeyOf,
  sessionMatchesGuild,
  latestMatchingSession,
  planGuildReconcile,
} from "./guild-session-sync"

function session(partial: Partial<ChatSession>): ChatSession {
  return {
    id: "s",
    title: "t",
    kind: "direct",
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  } as unknown as ChatSession
}

const dm: SelectedGuild = { kind: "dm" }
const teamA: SelectedGuild = { kind: "team", teamId: "A" }

describe("guildKeyOf", () => {
  it("namespaces team guilds by id and uses the kind otherwise", () => {
    expect(guildKeyOf(teamA)).toBe("team:A")
    expect(guildKeyOf(dm)).toBe("dm")
    expect(guildKeyOf({ kind: "canvas" })).toBe("canvas")
    expect(guildKeyOf({ kind: "plugin-view", containerId: "c" })).toBe("plugin-view")
  })
})

describe("sessionMatchesGuild", () => {
  it("matches team sessions to their own team only", () => {
    expect(sessionMatchesGuild(session({ kind: "team", teamId: "A" }), teamA)).toBe(true)
    expect(sessionMatchesGuild(session({ kind: "team", teamId: "B" }), teamA)).toBe(false)
    expect(sessionMatchesGuild(session({ kind: "direct" }), teamA)).toBe(false)
  })

  it("treats non-team, non-workflow sessions as the DM bucket", () => {
    expect(sessionMatchesGuild(session({ kind: "direct" }), dm)).toBe(true)
    expect(sessionMatchesGuild(session({ kind: "team", teamId: "A" }), dm)).toBe(false)
    expect(sessionMatchesGuild(session({ kind: "workflow-editor" }), dm)).toBe(false)
  })
})

describe("latestMatchingSession", () => {
  it("returns the most recently updated matching session", () => {
    const sessions = [
      session({ id: "old", kind: "team", teamId: "A", updatedAt: 1 }),
      session({ id: "new", kind: "team", teamId: "A", updatedAt: 9 }),
      session({ id: "other", kind: "team", teamId: "B", updatedAt: 99 }),
    ]
    expect(latestMatchingSession(sessions, teamA)?.id).toBe("new")
  })

  it("returns null when nothing matches", () => {
    expect(latestMatchingSession([session({ kind: "direct" })], teamA)).toBeNull()
  })

  it("treats a missing updatedAt as 0 when comparing", () => {
    const sessions = [
      session({ id: "a", kind: "team", teamId: "A", updatedAt: undefined as unknown as number }),
      session({ id: "b", kind: "team", teamId: "A", updatedAt: 5 }),
      session({ id: "c", kind: "team", teamId: "A", updatedAt: undefined as unknown as number }),
    ]
    expect(latestMatchingSession(sessions, teamA)?.id).toBe("b")
  })
})

describe("planGuildReconcile", () => {
  it("does nothing for canvas / plugin-view guilds", () => {
    expect(
      planGuildReconcile({
        guild: { kind: "canvas" },
        guildWins: true,
        activeSession: session({ kind: "direct" }),
        sessions: [],
      })
    ).toEqual({ type: "none" })
  })

  it("does nothing when the active session already belongs to the guild", () => {
    const active = session({ id: "a", kind: "team", teamId: "A" })
    expect(
      planGuildReconcile({
        guild: teamA,
        guildWins: true,
        activeSession: active,
        sessions: [active],
      })
    ).toEqual({ type: "none" })
  })

  describe("guild wins (deliberate guild navigation)", () => {
    it("resumes the most recent matching conversation", () => {
      const sessions = [
        session({ id: "t1", kind: "team", teamId: "A", updatedAt: 1 }),
        session({ id: "t2", kind: "team", teamId: "A", updatedAt: 5 }),
      ]
      expect(
        planGuildReconcile({
          guild: teamA,
          guildWins: true,
          activeSession: session({ id: "d", kind: "direct" }),
          sessions,
        })
      ).toEqual({ type: "select", sessionId: "t2" })
    })

    it("starts a new conversation for a team with none yet", () => {
      expect(
        planGuildReconcile({
          guild: teamA,
          guildWins: true,
          activeSession: session({ id: "d", kind: "direct" }),
          sessions: [session({ id: "d", kind: "direct" })],
        })
      ).toEqual({ type: "create-team", teamId: "A" })
    })

    it("clears the active session when switching to an empty DM bucket", () => {
      expect(
        planGuildReconcile({
          guild: dm,
          guildWins: true,
          activeSession: session({ id: "t", kind: "team", teamId: "A" }),
          sessions: [],
        })
      ).toEqual({ type: "clear" })
    })

    it("is a no-op for an empty DM bucket with nothing already active", () => {
      expect(
        planGuildReconcile({ guild: dm, guildWins: true, activeSession: null, sessions: [] })
      ).toEqual({ type: "none" })
    })
  })

  describe("session wins (resume / fork / cold start)", () => {
    it("pulls the guild over to the active session's bucket", () => {
      expect(
        planGuildReconcile({
          guild: dm,
          guildWins: false,
          activeSession: session({ id: "t", kind: "team", teamId: "A" }),
          sessions: [],
        })
      ).toEqual({ type: "sync-guild", guild: { kind: "team", teamId: "A" } })
    })

    it("auto-selects a sibling when the active session was cleared", () => {
      expect(
        planGuildReconcile({
          guild: teamA,
          guildWins: false,
          activeSession: null,
          sessions: [session({ id: "t1", kind: "team", teamId: "A", updatedAt: 3 })],
        })
      ).toEqual({ type: "select", sessionId: "t1" })
    })

    it("does nothing when there is no active session and no sibling (no recreate on delete)", () => {
      expect(
        planGuildReconcile({ guild: teamA, guildWins: false, activeSession: null, sessions: [] })
      ).toEqual({ type: "none" })
    })
  })
})
