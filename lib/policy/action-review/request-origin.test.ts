import {
  botInstructionEpoch,
  isRequesterInstruction,
  NON_INSTRUCTION_METADATA_KEYS,
  sessionOriginThread,
  taskInstructionEpoch,
  taskOriginThread,
  taskRequester,
  type ActionRequester,
} from "./request-origin"
import { conversationTarget } from "./outbound-targets"
import {
  AUTOMATED_TURN_PRODUCERS,
  automatedTurnMetadata,
} from "@cognia/agent-config-types/automated-turn"

const LOCAL: ActionRequester = { kind: "local" }
const ALICE: ActionRequester = { kind: "im", remoteUserId: "u-alice", platformIdentityId: "pi-1" }
const MEMBER: ActionRequester = { kind: "member", userId: "user-1" }

function user(metadata?: Record<string, unknown>) {
  return { role: "user" as const, ...(metadata ? { metadata } : {}) }
}

function imFrom(id: string, remoteUserId: string) {
  return user({ platformMessage: { messageId: "m", sender: { id, remoteUserId } } })
}

function authored(kind: string, id: string) {
  return user({ collaboration: { author: { kind, id } } })
}

describe("isRequesterInstruction", () => {
  it("counts only user rows", () => {
    expect(isRequesterInstruction(user(), LOCAL)).toBe(true)
    expect(isRequesterInstruction({ role: "assistant" }, LOCAL)).toBe(false)
    expect(isRequesterInstruction({ role: "system" }, LOCAL)).toBe(false)
  })

  it("never counts a row a producer marked as not typed by a person", () => {
    const marked = [
      ...NON_INSTRUCTION_METADATA_KEYS.map((key) => ({ [key]: { any: true } })),
      ...AUTOMATED_TURN_PRODUCERS.map((producer) => automatedTurnMetadata(producer)),
      { sessionPeerMessage: { origin: "agent", messageId: "p1" } },
    ]
    for (const metadata of marked) {
      for (const requester of [LOCAL, ALICE, MEMBER]) {
        expect(isRequesterInstruction(user(metadata), requester)).toBe(false)
      }
    }
  })

  it("pins the producers whose own key already marks their rows", () => {
    expect([...NON_INSTRUCTION_METADATA_KEYS]).toEqual([
      "larkImport",
      "importSourceOwned",
      "routerFusion",
    ])
  })

  it("counts a peer message the person wrote in the communication sheet", () => {
    expect(
      isRequesterInstruction(
        user({ sessionPeerMessage: { origin: "user", messageId: "p" } }),
        LOCAL
      )
    ).toBe(true)
  })

  it("matches an IM requester by identity or platform user id, and nobody else in the group", () => {
    expect(isRequesterInstruction(imFrom("pi-1", "other-remote"), ALICE)).toBe(true)
    expect(isRequesterInstruction(imFrom("pi-9", "u-alice"), ALICE)).toBe(true)
    expect(isRequesterInstruction(imFrom("pi-2", "u-bob"), ALICE)).toBe(false)
    // The local person's composer row is not the IM requester's instruction.
    expect(isRequesterInstruction(user(), ALICE)).toBe(false)
  })

  it("matches a shared-session member by their human author id only", () => {
    expect(isRequesterInstruction(authored("human", "user-1"), MEMBER)).toBe(true)
    expect(isRequesterInstruction(authored("human", "user-2"), MEMBER)).toBe(false)
    expect(isRequesterInstruction(authored("agent", "user-1"), MEMBER)).toBe(false)
    expect(isRequesterInstruction(user(), MEMBER)).toBe(false)
  })

  it("treats only authorless, non-IM rows as the local person's", () => {
    expect(isRequesterInstruction(imFrom("pi-1", "u-alice"), LOCAL)).toBe(false)
    expect(isRequesterInstruction(authored("human", "user-1"), LOCAL)).toBe(false)
    expect(isRequesterInstruction(authored("agent", "run:1"), LOCAL)).toBe(false)
  })
})

describe("task and Bot epochs", () => {
  it("names the revision, starting at 0", () => {
    expect(taskInstructionEpoch({ id: "t1" })).toBe("task:t1@0")
    expect(taskInstructionEpoch({ id: "t1", humanRevision: 3 })).toBe("task:t1@3")
    expect(botInstructionEpoch({ id: "b1" })).toBe("bot:b1@0")
    expect(botInstructionEpoch({ id: "b1", humanRevision: 2 })).toBe("bot:b1@2")
  })
})

describe("origin threads", () => {
  it("is the bound conversation of an IM session, thread dropped", () => {
    expect(
      sessionOriginThread({ platformBinding: { conversationKey: "lark:bot:oc_1:om_t" } })
    ).toEqual(conversationTarget("lark:bot:oc_1"))
    expect(sessionOriginThread({})).toBeUndefined()
  })

  it("is the /schedule conversation of an IM-authored task, and none otherwise", () => {
    const task = {
      payload: {
        scheduleProvenance: {
          source: "im",
          adapterId: "bot",
          conversationKey: "telegram:bot:chat",
          senderId: "u-alice",
        },
      },
    }
    expect(taskOriginThread(task)).toEqual(conversationTarget("telegram:bot:chat"))
    expect(taskRequester(task)).toEqual({ kind: "im", remoteUserId: "u-alice" })
    expect(taskOriginThread({ payload: { prompt: "p" } })).toBeUndefined()
    expect(taskRequester({})).toEqual({ kind: "local" })
  })
})
