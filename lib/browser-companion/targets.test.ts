import type { BrowserSubmissionRow } from "@/lib/db/browser-submissions-types"
import type { ChatTemplateRow } from "@/lib/db/chat-templates"
import type { BrowserDeliveryTargetV1 } from "@/types/browser-companion"

import {
  MAX_SESSION_TARGETS,
  agentTaskTargetId,
  browserFillableParams,
  issueTargetId,
  templateTargetId,
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

function template(overrides: Partial<ChatTemplateRow> = {}): ChatTemplateRow {
  return {
    id: "tpl-1",
    name: "Summarize",
    body: "Summarize this in {{tone}}.",
    params: [{ id: "tone", label: "Tone", required: true, kind: "string" }],
    revision: 1,
    usageCount: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function deps(
  rows: BrowserSubmissionRow[],
  templates: ChatTemplateRow[] = [],
  extra: {
    boards?: { id: string; name: string; workspaceId: string }[]
    agents?: { id: string; name: string }[]
  } = {}
) {
  return {
    listIssueProjects: async () => extra.boards ?? [],
    listTaskAgents: async () => extra.agents ?? [],
    listSubmissions: async (deviceId: string, limit: number) =>
      rows
        .filter((entry) => entry.deviceId === deviceId)
        .sort((left, right) => right.submittedAt - left.submittedAt)
        .slice(0, limit),
    listTemplates: async () => templates,
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

  it("looks past rows that are not append targets to fill the list", async () => {
    // The cap counts targets OFFERED, not rows scanned. Reading exactly
    // `MAX_SESSION_TARGETS` rows and then filtering emptied the dropdown the
    // moment somebody filed that many pages as issues — while appendable
    // conversations sat one row behind them in a ledger that keeps a hundred.
    const filed = Array.from({ length: MAX_SESSION_TARGETS }, (_unused, index) =>
      row({
        submissionId: `issue-sub-${index}`,
        sessionId: undefined,
        workKind: "issue",
        workId: `issue-${index}`,
        submittedAt: 1_000 + index,
      })
    )
    const conversations = Array.from({ length: 2 }, (_unused, index) =>
      row({
        submissionId: `chat-sub-${index}`,
        sessionId: `session-${index}`,
        submittedAt: 100 + index,
      })
    )
    const targets = await listDeliveryTargets(deps([...filed, ...conversations]), "browser-a")
    expect(targets.filter((target) => target.kind === "session")).toHaveLength(2)
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

describe("templates as delivery targets", () => {
  it("offers a saved template with the fields the panel has to show", async () => {
    const targets = await listDeliveryTargets(deps([], [template()]), "browser-a")
    expect(targets[1]).toMatchObject({
      id: templateTargetId("tpl-1"),
      kind: "template",
      label: "Summarize",
      params: [{ id: "tone", label: "Tone", required: true, kind: "string" }],
    })
    // No workspace: a template says how to start a task, not where. It runs in
    // whichever workspace the submission names, exactly as a new task does.
    expect(targets[1]).not.toHaveProperty("workspaceId")
  })

  it("does not offer a template a browser cannot fill", async () => {
    // A `resource` parameter is picked through the `@` menu against the Host's
    // own workspace. A side panel has no such picker and must not grow a way to
    // enumerate the Host's files to build one, so the honest answer is to leave
    // the template out rather than show a field nobody can complete.
    const withResource = template({
      id: "tpl-2",
      params: [
        { id: "file", label: "File", required: true, kind: "resource", resourceKind: "file" },
      ],
    })
    expect(browserFillableParams(withResource)).toBeNull()
    const targets = await listDeliveryTargets(deps([], [template(), withResource]), "browser-a")
    expect(targets.map((entry) => entry.id)).toEqual([
      NEW_CHAT_TARGET_ID,
      templateTargetId("tpl-1"),
    ])
  })

  it("prefers the last used value over the declared default", async () => {
    // What the composer offers, for the same reason: nine uses out of ten
    // repeat most of the values.
    const remembered = template({
      params: [
        { id: "tone", label: "Tone", required: true, kind: "string", defaultValue: "terse" },
      ],
      lastParams: { tone: { kind: "text", value: "plain English" } },
    })
    expect(browserFillableParams(remembered)?.[0].defaultValue).toBe("plain English")
  })

  it("does not offer a resource pick as a remembered default either", async () => {
    const resourceLast = template({
      lastParams: { tone: { kind: "resource", resourceKind: "file", id: "f1", label: "app.ts" } },
      params: [
        { id: "tone", label: "Tone", required: true, kind: "string", defaultValue: "terse" },
      ],
    })
    // The remembered value is not text, so it cannot be prefilled into a text
    // field — the declared default stands rather than a label pretending to be
    // one.
    expect(browserFillableParams(resourceLast)?.[0].defaultValue).toBe("terse")
  })

  it("omits an empty parameter list rather than sending one", async () => {
    const noParams = template({ body: "Summarize this page.", params: [] })
    const targets = await listDeliveryTargets(deps([], [noParams]), "browser-a")
    expect(targets[1]).not.toHaveProperty("params")
  })
})

describe("issue and agent-task targets", () => {
  it("offers a board only under the workspace it belongs to", async () => {
    // Filing does not move an issue between workspaces, any more than an
    // append moves a conversation.
    const targets = await listDeliveryTargets(
      deps([], [], { boards: [{ id: "board-1", name: "Inbox", workspaceId: "ws-other" }] }),
      "browser-a"
    )
    expect(targets[1]).toMatchObject({
      id: issueTargetId("board-1"),
      kind: "issue",
      label: "Inbox",
      workspaceId: "ws-other",
    })
  })

  it("offers an agent in every workspace, because a task is created in the chosen one", async () => {
    const targets = await listDeliveryTargets(
      deps([], [], { agents: [{ id: "char-1", name: "Researcher" }] }),
      "browser-a"
    )
    expect(targets[1]).toMatchObject({
      id: agentTaskTargetId("char-1"),
      kind: "agent-task",
      label: "Researcher",
    })
    expect(targets[1]).not.toHaveProperty("workspaceId")
  })

  it("offers no agent when the Host cannot run one", async () => {
    // An agent task needs the sidecar. A Host without one would accept the task
    // and refuse it at dispatch, which is a worse answer than not offering it —
    // so the reader returns nothing and there is no target.
    const targets = await listDeliveryTargets(deps([], [], { agents: [] }), "browser-a")
    expect(targets.map((entry) => entry.kind)).toEqual(["chat"])
  })

  it("does not offer non-conversation work as something to append to", async () => {
    // "Add this page to that" means something different for an issue and for a
    // task, and the append path only knows how to enqueue into a transcript.
    const targets = await listDeliveryTargets(
      deps([
        row({ submissionId: "a", sessionId: "session-a", status: "completed" }),
        row({
          submissionId: "b",
          sessionId: undefined,
          workKind: "issue",
          workId: "issue-1",
          status: "queued",
          submittedAt: 9,
        }),
      ]),
      "browser-a"
    )
    expect(targets.map((entry) => entry.id)).toEqual([
      NEW_CHAT_TARGET_ID,
      sessionTargetId("session-a"),
    ])
  })
})
