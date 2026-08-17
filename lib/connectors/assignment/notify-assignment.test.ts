const mockNotify = jest.fn<Promise<string>, [unknown]>()
jest.mock("@/lib/notifications/runtime", () => ({
  notify: (...args: unknown[]) => mockNotify(...(args as [unknown])),
}))

import {
  ASSIGNMENT_NOTICE,
  assignmentHref,
  describeAssignee,
  notifyAssignmentChanged,
} from "./notify-assignment"

beforeEach(() => {
  mockNotify.mockReset()
  mockNotify.mockResolvedValue("n1")
})

describe("notifyAssignmentChanged", () => {
  it("notifies center + toast with a deep link and per-conversation dedupe on assign", async () => {
    await notifyAssignmentChanged({
      conversationKey: "lark:adp:oc_1",
      from: null,
      to: { kind: "human" },
      via: "manual",
    })
    expect(mockNotify).toHaveBeenCalledTimes(1)
    const input = mockNotify.mock.calls[0][0] as Record<string, unknown>
    expect(input).toMatchObject({
      source: "connector",
      level: "info",
      title: ASSIGNMENT_NOTICE.assigned.title,
      channels: ["center", "toast"],
      href: "/inbox/c?key=lark%3Aadp%3Aoc_1",
      groupKey: "lark:adp:oc_1",
      dedupeKey: "assign:lark:adp:oc_1",
      sourceRef: { kind: "conversation", id: "lark:adp:oc_1" },
      directed: true,
      meta: { kind: "assigned", via: "manual" },
    })
    expect(String(input.body)).toContain("人工 / me")
    expect(String(input.body)).toContain("（manual）")
  })

  it("renders reassigned as from → to and is not directed for AI targets", async () => {
    await notifyAssignmentChanged({
      conversationKey: "k",
      from: { kind: "character", id: "c1", label: "Ava" },
      to: { kind: "team", id: "t1", label: "Support" },
      via: "manual",
    })
    const input = mockNotify.mock.calls[0][0] as Record<string, unknown>
    expect(input.title).toBe(ASSIGNMENT_NOTICE.reassigned.title)
    expect(String(input.body)).toContain("角色 Ava / character Ava → 团队 Support / team Support")
    expect(input.directed).toBe(false)
  })

  it("renders unassigned and escalates the level for sla-escalation provenance", async () => {
    await notifyAssignmentChanged({
      conversationKey: "k",
      from: { kind: "team", id: "t1" },
      to: null,
      via: "sla-escalation",
    })
    const input = mockNotify.mock.calls[0][0] as Record<string, unknown>
    expect(input.title).toBe(ASSIGNMENT_NOTICE.unassigned.title)
    expect(input.level).toBe("warning")
    expect(String(input.body)).toContain("团队 t1 / team t1")
  })

  it("is a no-op when the assignee did not change", async () => {
    await notifyAssignmentChanged({
      conversationKey: "k",
      from: { kind: "character", id: "c1" },
      to: { kind: "character", id: "c1", label: "renamed" },
      via: "manual",
    })
    await notifyAssignmentChanged({
      conversationKey: "k",
      from: null,
      to: undefined,
      via: "manual",
    })
    expect(mockNotify).not.toHaveBeenCalled()
  })

  it("swallows notify failures (best-effort)", async () => {
    mockNotify.mockRejectedValueOnce(new Error("center down"))
    await expect(
      notifyAssignmentChanged({ conversationKey: "k", from: null, to: { kind: "human" }, via: "x" })
    ).resolves.toBeUndefined()
  })

  it("describeAssignee falls back to id then '?' and assignmentHref encodes the key", () => {
    expect(describeAssignee(null)).toBe("无 / none")
    expect(describeAssignee({ kind: "character", id: "c9" })).toBe("角色 c9 / character c9")
    expect(describeAssignee({ kind: "team" })).toBe("团队 ? / team ?")
    expect(assignmentHref("a:b:c")).toBe("/inbox/c?key=a%3Ab%3Ac")
  })
})
