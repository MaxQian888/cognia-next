/**
 * Tests for the terminal collaboration share manager.
 */

import {
  createInvite,
  isInviteValid,
  revokeInvite,
  acceptInvite,
  createSharedState,
  addParticipant,
  removeParticipant,
  changeParticipantRole,
  markDisconnected,
  endSharedSession,
  buildShareUrl,
  DEFAULT_INVITE_EXPIRY_MS,
  MAX_PARTICIPANTS,
  __resetShareIdCounterForTesting,
} from "./share-manager"
import type { TerminalShareInvite, SharedParticipant } from "./types"

describe("collaboration/share-manager", () => {
  beforeEach(() => {
    __resetShareIdCounterForTesting()
  })

  describe("createInvite", () => {
    it("creates an invite with defaults", () => {
      const invite = createInvite("session-1", undefined, {
        generateId: () => "inv-1",
        generateToken: () => "token-abc",
        now: () => 1000,
      })

      expect(invite.id).toBe("inv-1")
      expect(invite.sessionId).toBe("session-1")
      expect(invite.token).toBe("token-abc")
      expect(invite.grantedRole).toBe("viewer")
      expect(invite.status).toBe("pending")
      expect(invite.createdAt).toBe(1000)
      expect(invite.expiresAt).toBe(1000 + DEFAULT_INVITE_EXPIRY_MS)
      expect(invite.maxParticipants).toBe(MAX_PARTICIPANTS)
      expect(invite.participantCount).toBe(0)
    })

    it("respects custom role and expiry", () => {
      const invite = createInvite(
        "s1",
        { role: "editor", expiryMs: 5000, maxParticipants: 3 },
        { now: () => 2000 }
      )

      expect(invite.grantedRole).toBe("editor")
      expect(invite.expiresAt).toBe(7000)
      expect(invite.maxParticipants).toBe(3)
    })

    it("sets expiresAt to null when expiryMs is 0", () => {
      const invite = createInvite("s1", { expiryMs: 0 })
      expect(invite.expiresAt).toBeNull()
    })
  })

  describe("isInviteValid", () => {
    function makeInvite(overrides?: Partial<TerminalShareInvite>): TerminalShareInvite {
      return {
        id: "inv-1",
        sessionId: "s1",
        token: "tok",
        grantedRole: "viewer",
        status: "pending",
        createdAt: 1000,
        expiresAt: 10000,
        maxParticipants: 5,
        participantCount: 0,
        ...overrides,
      }
    }

    it("returns true for valid invite", () => {
      expect(isInviteValid(makeInvite(), 5000)).toBe(true)
    })

    it("returns false for revoked invite", () => {
      expect(isInviteValid(makeInvite({ status: "revoked" }))).toBe(false)
    })

    it("returns false for expired status", () => {
      expect(isInviteValid(makeInvite({ status: "expired" }))).toBe(false)
    })

    it("returns false when past expiry time", () => {
      expect(isInviteValid(makeInvite({ expiresAt: 5000 }), 6000)).toBe(false)
    })

    it("returns true when before expiry time", () => {
      expect(isInviteValid(makeInvite({ expiresAt: 5000 }), 4000)).toBe(true)
    })

    it("returns false when at max participants", () => {
      expect(isInviteValid(makeInvite({ maxParticipants: 3, participantCount: 3 }), 1000)).toBe(
        false
      )
    })

    it("returns true with null expiresAt (never expires)", () => {
      expect(isInviteValid(makeInvite({ expiresAt: null }), 999999)).toBe(true)
    })

    it("returns true with null maxParticipants (unlimited)", () => {
      expect(
        isInviteValid(makeInvite({ maxParticipants: null, participantCount: 100 }), 1000)
      ).toBe(true)
    })
  })

  describe("revokeInvite", () => {
    it("sets status to revoked", () => {
      const invite = createInvite("s1", undefined, { now: () => 1000 })
      const revoked = revokeInvite(invite)
      expect(revoked.status).toBe("revoked")
      expect(revoked.id).toBe(invite.id)
    })
  })

  describe("acceptInvite", () => {
    it("creates a participant and updates invite", () => {
      const invite = createInvite(
        "s1",
        { role: "editor" },
        {
          now: () => 1000,
          generateId: () => "inv-1",
          generateToken: () => "tok",
        }
      )

      const result = acceptInvite(invite, "peer-1", "Alice", { now: () => 2000 })
      expect(result).not.toBeNull()
      expect(result!.participant.peerId).toBe("peer-1")
      expect(result!.participant.name).toBe("Alice")
      expect(result!.participant.role).toBe("editor")
      expect(result!.participant.connected).toBe(true)
      expect(result!.updatedInvite.participantCount).toBe(1)
      expect(result!.updatedInvite.status).toBe("active")
    })

    it("returns null for invalid invite", () => {
      const invite = createInvite("s1", undefined, { now: () => 1000 })
      const revoked = revokeInvite(invite)
      expect(acceptInvite(revoked, "peer-1", "Bob")).toBeNull()
    })
  })

  describe("shared state operations", () => {
    const participant: SharedParticipant = {
      peerId: "p1",
      name: "Alice",
      role: "viewer",
      joinedAt: 1000,
      connected: true,
    }

    it("createSharedState initializes empty state", () => {
      const invite = createInvite("s1")
      const state = createSharedState(invite)
      expect(state.active).toBe(true)
      expect(state.participants).toHaveLength(0)
    })

    it("addParticipant adds to the list", () => {
      const invite = createInvite("s1")
      const state = addParticipant(createSharedState(invite), participant)
      expect(state.participants).toHaveLength(1)
      expect(state.participants[0].name).toBe("Alice")
    })

    it("removeParticipant removes by peerId", () => {
      const invite = createInvite("s1")
      let state = createSharedState(invite)
      state = addParticipant(state, participant)
      state = addParticipant(state, { ...participant, peerId: "p2", name: "Bob" })
      state = removeParticipant(state, "p1")

      expect(state.participants).toHaveLength(1)
      expect(state.participants[0].name).toBe("Bob")
    })

    it("changeParticipantRole updates the role", () => {
      const invite = createInvite("s1")
      let state = addParticipant(createSharedState(invite), participant)
      state = changeParticipantRole(state, "p1", "editor")

      expect(state.participants[0].role).toBe("editor")
    })

    it("markDisconnected sets connected to false", () => {
      const invite = createInvite("s1")
      let state = addParticipant(createSharedState(invite), participant)
      state = markDisconnected(state, "p1")

      expect(state.participants[0].connected).toBe(false)
    })

    it("endSharedSession marks inactive and revokes invite", () => {
      const invite = createInvite("s1")
      let state = addParticipant(createSharedState(invite), participant)
      state = endSharedSession(state)

      expect(state.active).toBe(false)
      expect(state.invite?.status).toBe("revoked")
      expect(state.participants[0].connected).toBe(false)
    })
  })

  describe("buildShareUrl", () => {
    it("builds correct URL", () => {
      const invite = createInvite("s1", undefined, {
        generateId: () => "inv-123",
        generateToken: () => "tok-abc",
      })
      const url = buildShareUrl(invite, "https://app.cognia.dev")
      expect(url).toBe("https://app.cognia.dev/terminal/share?id=inv-123&token=tok-abc")
    })
  })
})
