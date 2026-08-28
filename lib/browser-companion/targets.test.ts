import type { BrowserSubmissionRow } from "@/lib/db/browser-submissions-types"
import type { BrowserDeliveryTargetV1 } from "@/types/browser-companion"

import {
  MAX_SESSION_TARGETS,
  NEW_CHAT_LABEL,
  NEW_CHAT_TARGET_ID,
  listDeliveryTargets,
  resolveDeliveryTarget,
  sessionIdOfTarget,
  sessionTargetId,
} from "./targets"

function row(overrides: Partial<BrowserSubmissionRow> = {}): BrowserSubmissionRow {
  return {
    submissionId: "sub-1",
    deviceId: "browser-a",
    sessionId: "session-1",
    title: "A guide",
    sourceHost: "example.com",
    workspaceId: "ws-default",
    targetId: NEW_CHAT_TARGET_ID,
    captureMode: "selection",
    contentBytes: 120,
    truncated: false,
    status: "queued",
    submittedAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  }
}

function deps(rows: BrowserSubmissionRow[]) {
  return {
    listSubmissions: async (deviceId: string, limit: number) =>
      rows
        .filter((entry) => entry.deviceId === deviceId)
        .sort((left, right) => right.submittedAt - left.submittedAt)
        .slice(0, limit),
  }
}

describe("listDeliveryTargets", () => {
  it("always offers a new task, and offers it as the default", async () => {
    const targets = await listDeliveryTargets(deps([]), "browser-a")
    expect(targets).toEqual([
      { id: NEW_CHAT_TARGET_ID, kind: "chat", label: NEW_CHAT_LABEL, isDefault: true },
    ])
  })

  it("offers only the sessions this device started", async () => {
    // The bound that makes an append safe. Without it, "add to an existing
    // conversation" would be a way for a browser to reach any session on the
    // machine — including ones started on the desktop, and ones belonging to a
    // second paired browser.
    const targets = await listDeliveryTargets(
      deps([
        row({ submissionId: "mine", sessionId: "session-mine" }),
        row({ submissionId: "theirs", deviceId: "browser-b", sessionId: "session-theirs" }),
      ]),
      "browser-a"
    )
    expect(targets.map((target) => target.id)).toEqual([
      NEW_CHAT_TARGET_ID,
      sessionTargetId("session-mine"),
    ])
  })

  it("offers nothing but a new task to an unbound caller", async () => {
    const targets = await listDeliveryTargets(deps([row()]), "")
    expect(targets).toHaveLength(1)
  })

  it("does not offer a conversation that was never started", async () => {
    // `submitting` and `failed` describe a submission whose enqueue did not
    // land, so the session it names has nothing in it. Its own retry is how it
    // gets finished; offering it here would look like a second way to do that.
    const targets = await listDeliveryTargets(
      deps([
        row({ submissionId: "a", sessionId: "session-a", status: "failed", submittedAt: 3 }),
        row({ submissionId: "b", sessionId: "session-b", status: "submitting", submittedAt: 2 }),
        row({ submissionId: "c", sessionId: "session-c", status: "completed", submittedAt: 1 }),
      ]),
      "browser-a"
    )
    expect(targets.map((target) => target.id)).toEqual([
      NEW_CHAT_TARGET_ID,
      sessionTargetId("session-c"),
    ])
  })

  it("carries the workspace a session belongs to, so it is not offered elsewhere", async () => {
    const targets = await listDeliveryTargets(deps([row({ workspaceId: "ws-other" })]), "browser-a")
    expect(targets[1]).toMatchObject({ workspaceId: "ws-other", detail: "example.com" })
  })

  it("leaves a row written before the field existed available everywhere", async () => {
    // Narrowing it would need a session read this table is deliberately
    // independent of, and refusing it outright would retire history the user
    // can still see in the recent list.
    const legacy = row()
    delete legacy.workspaceId
    const targets = await listDeliveryTargets(deps([legacy]), "browser-a")
    expect(targets[1]).not.toHaveProperty("workspaceId")
  })

  it("keeps the list short enough to read", async () => {
    const rows = Array.from({ length: MAX_SESSION_TARGETS + 4 }, (_unused, index) =>
      row({
        submissionId: `sub-${index}`,
        sessionId: `session-${index}`,
        submittedAt: index,
      })
    )
    const targets = await listDeliveryTargets(deps(rows), "browser-a")
    expect(targets).toHaveLength(MAX_SESSION_TARGETS + 1)
    // Newest first, so the conversation a person is most likely to mean is the
    // one nearest the top.
    expect(targets[1].id).toBe(sessionTargetId(`session-${MAX_SESSION_TARGETS + 3}`))
  })
})

describe("resolveDeliveryTarget", () => {
  const offered: BrowserDeliveryTargetV1[] = [
    { id: NEW_CHAT_TARGET_ID, kind: "chat", label: NEW_CHAT_LABEL, isDefault: true },
    { id: sessionTargetId("session-1"), kind: "session", label: "A guide", isDefault: false },
  ]

  it("answers the default when the caller named nothing", async () => {
    expect(resolveDeliveryTarget(offered, undefined)?.id).toBe(NEW_CHAT_TARGET_ID)
  })

  it("refuses an id that was never offered", () => {
    // The security property, and the reason this is a lookup rather than a
    // parse: `session:session-99` is a well-formed id for a real session, and
    // the only thing stopping a browser from naming it is that it is not in
    // the list this Host just built.
    expect(resolveDeliveryTarget(offered, sessionTargetId("session-99"))).toBeUndefined()
    expect(resolveDeliveryTarget(offered, "issue:anything")).toBeUndefined()
  })

  it("returns the offered entry, never a value derived from the id", () => {
    const resolved = resolveDeliveryTarget(offered, sessionTargetId("session-1"))
    expect(resolved).toBe(offered[1])
  })
})

describe("sessionIdOfTarget", () => {
  it("names the conversation a session target appends to", () => {
    expect(
      sessionIdOfTarget({
        id: sessionTargetId("session-7"),
        kind: "session",
        label: "x",
        isDefault: false,
      })
    ).toBe("session-7")
  })

  it("answers nothing for a target that creates its own conversation", () => {
    expect(
      sessionIdOfTarget({
        id: NEW_CHAT_TARGET_ID,
        kind: "chat",
        label: NEW_CHAT_LABEL,
        isDefault: true,
      })
    ).toBeUndefined()
  })
})
