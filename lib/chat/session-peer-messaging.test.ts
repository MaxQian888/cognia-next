import type { ChatSession } from "@cognia/agent-config-types"

import type { SessionPeerMessageRow } from "@/lib/db/session-peer-messages"
import {
  decideHeldSessionPeerMessage,
  drainSessionPeerMessages,
  listReachableSessions,
  sendSessionPeerMessage,
  type SessionPeerMessagingDeps,
} from "./session-peer-messaging"

function session(id: string, patch: Partial<ChatSession> = {}): ChatSession {
  return {
    id,
    projectId: "project-1",
    title: id,
    kind: "direct",
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  }
}

function setup() {
  let now = 1_000
  const sessions = new Map<string, ChatSession>([
    ["sender", session("sender")],
    ["receiver", session("receiver", { crossSessionInboundPolicy: "accept" })],
    ["held", session("held", { crossSessionInboundPolicy: "hold" })],
    ["refused", session("refused", { crossSessionInboundPolicy: "refuse" })],
    ["other-project", session("other-project", { projectId: "project-2" })],
  ])
  const reachable = new Set(["sender", "receiver", "held", "refused", "other-project"])
  const statuses = new Map<string, "idle" | "streaming">()
  const rows = new Map<string, SessionPeerMessageRow>()
  const delivered: SessionPeerMessageRow[] = []
  let counter = 0

  const deps: SessionPeerMessagingDeps = {
    listSessions: async () => [...sessions.values()],
    getSession: async (id) => sessions.get(id),
    isReachable: (id) => reachable.has(id),
    getStatus: (id) => statuses.get(id) ?? "idle",
    createMessage: async (input) => {
      const row: SessionPeerMessageRow = {
        ...input,
        id: input.id ?? `peer-${++counter}`,
        authority: "untrusted_agent_message",
        status: "queued",
        createdAt: input.createdAt ?? now,
        updatedAt: input.createdAt ?? now,
        expiresAt: input.expiresAt ?? now + 300_000,
      }
      rows.set(row.id, row)
      return row
    },
    getMessage: async (id) => rows.get(id),
    transitionMessage: async (id, status, updatedAt, statusReason) => {
      const current = rows.get(id)!
      const next = {
        ...current,
        status,
        updatedAt,
        ...(statusReason ? { statusReason } : {}),
        ...(status === "delivered" ? { deliveredAt: updatedAt } : {}),
      }
      rows.set(id, next)
      return next
    },
    listInbox: async (receiverSessionId) =>
      [...rows.values()]
        .filter((row) => row.receiverSessionId === receiverSessionId)
        .sort((a, b) => a.createdAt - b.createdAt),
    listOutbox: async (senderSessionId) =>
      [...rows.values()]
        .filter((row) => row.senderSessionId === senderSessionId)
        .sort((a, b) => b.createdAt - a.createdAt),
    enforceCapacity: async () => 0,
    deliver: async (row) => {
      delivered.push(row)
    },
    gateAgentMessage: () => true,
    now: () => now,
  }
  return {
    deps,
    sessions,
    reachable,
    statuses,
    rows,
    delivered,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe("listReachableSessions", () => {
  it("returns live standard peers in the sender workspace and excludes itself", async () => {
    const { deps, sessions } = setup()
    sessions.set(
      "embedded",
      session("embedded", { kind: "resource-workbench", visibility: "embedded" })
    )

    expect((await listReachableSessions("sender", deps)).map((row) => row.id).sort()).toEqual([
      "held",
      "receiver",
      "refused",
    ])
  })
})

describe("sendSessionPeerMessage", () => {
  it("delivers an accepted trigger immediately to an idle receiver", async () => {
    const { deps, delivered } = setup()

    const receipt = await sendSessionPeerMessage(
      {
        senderSessionId: "sender",
        receiverSessionId: "receiver",
        content: "Please review the migration",
        intent: "trigger_turn",
        origin: "agent",
      },
      deps
    )

    expect(receipt.status).toBe("delivered")
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({
      authority: "untrusted_agent_message",
      origin: "agent",
    })
  })

  it("rejects agent-originated content when the transport PII gate blocks it", async () => {
    const { deps } = setup()
    deps.gateAgentMessage = () => false

    await expect(
      sendSessionPeerMessage(
        {
          senderSessionId: "sender",
          receiverSessionId: "receiver",
          content: "private payload",
          intent: "trigger_turn",
          origin: "agent",
        },
        deps
      )
    ).rejects.toThrow("blocked by the PII redaction gate")
  })

  it("queues accepted messages until a streaming receiver reaches a safe boundary", async () => {
    const { deps, statuses, delivered } = setup()
    statuses.set("receiver", "streaming")

    const queued = await sendSessionPeerMessage(
      {
        senderSessionId: "sender",
        receiverSessionId: "receiver",
        content: "Check the latest test output",
        intent: "trigger_turn",
        origin: "agent",
      },
      deps
    )
    expect(queued.status).toBe("queued")
    expect(delivered).toHaveLength(0)

    statuses.set("receiver", "idle")
    expect(await drainSessionPeerMessages("receiver", deps)).toBe(1)
    expect(delivered).toHaveLength(1)
  })

  it("persists held and refused receiver decisions without invoking delivery", async () => {
    const { deps, delivered } = setup()

    const held = await sendSessionPeerMessage(
      {
        senderSessionId: "sender",
        receiverSessionId: "held",
        content: "Hold this",
        intent: "note",
        origin: "agent",
      },
      deps
    )
    const refused = await sendSessionPeerMessage(
      {
        senderSessionId: "sender",
        receiverSessionId: "refused",
        content: "Refuse this",
        intent: "note",
        origin: "agent",
      },
      deps
    )

    expect(held.status).toBe("held")
    expect(refused.status).toBe("refused")
    expect(delivered).toHaveLength(0)
  })

  it("lets only the receiver accept or refuse a held message", async () => {
    const { deps, delivered } = setup()
    const held = await sendSessionPeerMessage(
      {
        senderSessionId: "sender",
        receiverSessionId: "held",
        content: "Approve this",
        intent: "note",
        origin: "agent",
      },
      deps
    )

    await expect(decideHeldSessionPeerMessage(held.id, "accept", "sender", deps)).rejects.toThrow(
      "does not own"
    )
    expect(await decideHeldSessionPeerMessage(held.id, "accept", "held", deps)).toMatchObject({
      status: "delivered",
    })
    expect(delivered).toHaveLength(1)
  })

  it("returns a terminal unavailable receipt when the target is not live", async () => {
    const { deps, reachable } = setup()
    reachable.delete("receiver")

    const receipt = await sendSessionPeerMessage(
      {
        senderSessionId: "sender",
        receiverSessionId: "receiver",
        content: "Are you there?",
        intent: "note",
        origin: "user",
      },
      deps
    )

    expect(receipt.status).toBe("target_unavailable")
  })

  it("refuses duplicate agent loops and sender floods with explicit receipts", async () => {
    const { deps, advance } = setup()
    const input = {
      senderSessionId: "sender",
      receiverSessionId: "receiver",
      content: "same message",
      intent: "note" as const,
      origin: "agent" as const,
    }
    expect((await sendSessionPeerMessage(input, deps)).status).toBe("delivered")
    advance(1)
    const duplicate = await sendSessionPeerMessage(input, deps)
    expect(duplicate).toMatchObject({ status: "refused", statusReason: "Duplicate message" })

    for (let index = 0; index < 8; index += 1) {
      advance(1)
      await sendSessionPeerMessage({ ...input, content: `unique-${index}` }, deps)
    }
    advance(1)
    const flooded = await sendSessionPeerMessage({ ...input, content: "one-too-many" }, deps)
    expect(flooded).toMatchObject({ status: "refused", statusReason: "Sender rate limit exceeded" })
  })
})
