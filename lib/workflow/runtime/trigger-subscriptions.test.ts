import type { WorkflowRow } from "@/types/workflow/visual"
import {
  _peekTriggerSubscriptions,
  _seedTriggerSubscriptionsForTest,
  disposeTriggerSubscriptions,
  findMatchingWorkflows,
} from "./trigger-subscriptions"

function wf(id: string, nodes: WorkflowRow["nodes"]): WorkflowRow {
  return {
    id,
    schemaVersion: 1,
    name: id,
    createdAt: 0,
    updatedAt: 0,
    nodes,
    edges: [],
    settings: {} as WorkflowRow["settings"],
  }
}

function trigger(
  id: string,
  type: WorkflowRow["nodes"][number]["type"],
  params: Record<string, unknown>
) {
  return {
    id,
    type,
    typeVersion: 1,
    position: { x: 0, y: 0 },
    data: { params },
  } as WorkflowRow["nodes"][number]
}

afterEach(() => {
  disposeTriggerSubscriptions()
})

describe("trigger-subscriptions", () => {
  it("excludes disabled triggers, templates, and built-in gallery rows", () => {
    const disabled = trigger("n_disabled", "trigger.chat.message", {})
    disabled.data.disabled = true
    _seedTriggerSubscriptionsForTest([
      wf("wf_active", [trigger("n_active", "trigger.chat.message", {})]),
      wf("wf_disabled", [disabled]),
      {
        ...wf("wf_template", [trigger("n_template", "trigger.chat.message", {})]),
        isTemplate: true,
      },
      { ...wf("wf_builtin", [trigger("n_builtin", "trigger.chat.message", {})]), isBuiltIn: true },
    ])

    expect(
      findMatchingWorkflows("trigger.chat.message", {}).map((entry) => entry.workflowId)
    ).toEqual(["wf_active"])
  })

  it("indexes only chat.message and connector.inbound triggers", () => {
    _seedTriggerSubscriptionsForTest([
      wf("wf_a", [
        trigger("n1", "trigger.connector.inbound", { adapterId: "tg" }),
        trigger("n2", "trigger.cron", { cron: "* * * * *" }),
        trigger("n3", "trigger.webhook", { path: "/hook" }),
      ]),
      wf("wf_b", [trigger("n4", "trigger.chat.message", { characterId: "char_1" })]),
    ])
    const idx = _peekTriggerSubscriptions()
    expect(idx.get("trigger.connector.inbound")).toHaveLength(1)
    expect(idx.get("trigger.chat.message")).toHaveLength(1)
    expect(idx.get("trigger.cron" as never)).toBeUndefined()
    expect(idx.get("trigger.webhook" as never)).toBeUndefined()
  })

  it("matches integration events without platform-specific workflow kinds", () => {
    _seedTriggerSubscriptionsForTest([
      wf("wf_repo", [
        trigger("n", "trigger.integration.event", {
          pluginId: "github-delivery",
          accountId: "account-1",
          eventTypes: ["pull_request.opened", "issue.opened"],
          resourceKind: "repository",
          resourceId: "cognia/cognia-next",
        }),
      ]),
      wf("wf_any", [trigger("n", "trigger.integration.event", {})]),
    ])

    const matches = findMatchingWorkflows("trigger.integration.event", {
      pluginId: "github-delivery",
      integrationId: "github",
      accountId: "account-1",
      eventType: "pull_request.opened",
      resourceKind: "repository",
      resourceId: "cognia/cognia-next",
    })
    expect(matches.map((match) => match.workflowId)).toEqual(["wf_repo", "wf_any"])

    const other = findMatchingWorkflows("trigger.integration.event", {
      pluginId: "linear-delivery",
      accountId: "account-1",
      eventType: "issue.created",
    })
    expect(other.map((match) => match.workflowId)).toEqual(["wf_any"])
  })

  it("matches connector.inbound by adapterId when params bind it", () => {
    _seedTriggerSubscriptionsForTest([
      wf("wf_tg", [trigger("n", "trigger.connector.inbound", { adapterId: "tg" })]),
      wf("wf_disc", [trigger("n", "trigger.connector.inbound", { adapterId: "discord" })]),
      wf("wf_any", [trigger("n", "trigger.connector.inbound", {})]),
    ])
    const tg = findMatchingWorkflows("trigger.connector.inbound", { adapterId: "tg" })
    expect(tg.map((m) => m.workflowId)).toEqual(expect.arrayContaining(["wf_tg", "wf_any"]))
    expect(tg.map((m) => m.workflowId)).not.toContain("wf_disc")
  })

  it("matches connector.inbound fine-grained filters (senderIds / channelKinds / keywords / requireMention)", () => {
    _seedTriggerSubscriptionsForTest([
      wf("wf_sender", [
        trigger("n", "trigger.connector.inbound", { adapterId: "tg", senderIds: ["u1", "u2"] }),
      ]),
      wf("wf_group", [
        trigger("n", "trigger.connector.inbound", { adapterId: "tg", channelKinds: ["group"] }),
      ]),
      wf("wf_kw", [
        trigger("n", "trigger.connector.inbound", { adapterId: "tg", keywords: ["Deploy"] }),
      ]),
      wf("wf_mention", [
        trigger("n", "trigger.connector.inbound", { adapterId: "tg", requireMention: true }),
      ]),
      wf("wf_any", [trigger("n", "trigger.connector.inbound", { adapterId: "tg" })]),
    ])

    const base = {
      adapterId: "tg",
      senderId: "u1",
      channelKind: "group",
      plainText: "please deploy now",
      selfMentioned: false,
    }
    const hit = findMatchingWorkflows("trigger.connector.inbound", base).map((m) => m.workflowId)
    // sender u1 matches senderIds; group matches channelKinds; "deploy"
    // matches keywords case-insensitively; requireMention fails (false).
    expect(hit).toEqual(expect.arrayContaining(["wf_sender", "wf_group", "wf_kw", "wf_any"]))
    expect(hit).not.toContain("wf_mention")

    const other = findMatchingWorkflows("trigger.connector.inbound", {
      ...base,
      senderId: "u9",
      channelKind: "private",
      plainText: "hello",
      selfMentioned: true,
    }).map((m) => m.workflowId)
    expect(other).toEqual(expect.arrayContaining(["wf_mention", "wf_any"]))
    expect(other).not.toContain("wf_sender")
    expect(other).not.toContain("wf_group")
    expect(other).not.toContain("wf_kw")
  })

  it("matches chat.message by characterId and optionally by sessionId", () => {
    _seedTriggerSubscriptionsForTest([
      wf("wf_global", [trigger("n", "trigger.chat.message", { characterId: "char_a" })]),
      wf("wf_scoped", [
        trigger("n", "trigger.chat.message", { characterId: "char_a", sessionId: "sess_42" }),
      ]),
    ])
    const broad = findMatchingWorkflows("trigger.chat.message", {
      characterId: "char_a",
      sessionId: "sess_99",
    })
    expect(broad.map((m) => m.workflowId)).toEqual(["wf_global"])
    const narrow = findMatchingWorkflows("trigger.chat.message", {
      characterId: "char_a",
      sessionId: "sess_42",
    })
    expect(narrow.map((m) => m.workflowId)).toEqual(
      expect.arrayContaining(["wf_global", "wf_scoped"])
    )
  })

  it("indexes goal.completed and matches by goalId / status (unscoped matches any)", () => {
    _seedTriggerSubscriptionsForTest([
      wf("wf_any", [trigger("n", "trigger.goal.completed", {})]),
      wf("wf_goal", [trigger("n", "trigger.goal.completed", { goalId: "g1" })]),
      wf("wf_status", [trigger("n", "trigger.goal.completed", { status: "completed" })]),
    ])
    expect(_peekTriggerSubscriptions().get("trigger.goal.completed")).toHaveLength(3)

    const g1Completed = findMatchingWorkflows("trigger.goal.completed", {
      goalId: "g1",
      status: "completed",
    })
    expect(g1Completed.map((m) => m.workflowId)).toEqual(
      expect.arrayContaining(["wf_any", "wf_goal", "wf_status"])
    )

    // A different goal that stopped: only the unscoped node fires.
    const otherStopped = findMatchingWorkflows("trigger.goal.completed", {
      goalId: "g2",
      status: "stopped",
    })
    expect(otherStopped.map((m) => m.workflowId)).toEqual(["wf_any"])
  })

  it("indexes trigger.team and matches by teamId / status (unscoped matches any)", () => {
    _seedTriggerSubscriptionsForTest([
      wf("wf_any", [trigger("n", "trigger.team", {})]),
      wf("wf_team", [trigger("n", "trigger.team", { teamId: "team_1" })]),
      wf("wf_failed", [trigger("n", "trigger.team", { status: "failed" })]),
    ])
    expect(_peekTriggerSubscriptions().get("trigger.team")).toHaveLength(3)

    const t1Completed = findMatchingWorkflows("trigger.team", {
      teamId: "team_1",
      status: "completed",
    })
    expect(t1Completed.map((m) => m.workflowId)).toEqual(
      expect.arrayContaining(["wf_any", "wf_team"])
    )
    expect(t1Completed.map((m) => m.workflowId)).not.toContain("wf_failed")

    const otherFailed = findMatchingWorkflows("trigger.team", {
      teamId: "team_2",
      status: "failed",
    })
    expect(otherFailed.map((m) => m.workflowId)).toEqual(
      expect.arrayContaining(["wf_any", "wf_failed"])
    )
    expect(otherFailed.map((m) => m.workflowId)).not.toContain("wf_team")
  })

  it("indexes trigger.desktop.event and matches by kinds array (unscoped matches any)", () => {
    _seedTriggerSubscriptionsForTest([
      wf("wf_any", [trigger("n", "trigger.desktop.event", {})]),
      wf("wf_focus", [trigger("n", "trigger.desktop.event", { kinds: ["focus-changed"] })]),
      wf("wf_struct", [trigger("n", "trigger.desktop.event", { kinds: ["structure-changed"] })]),
    ])
    expect(_peekTriggerSubscriptions().get("trigger.desktop.event")).toHaveLength(3)

    const focus = findMatchingWorkflows("trigger.desktop.event", {
      desktopEventKind: "focus-changed",
    })
    expect(focus.map((m) => m.workflowId)).toEqual(expect.arrayContaining(["wf_any", "wf_focus"]))
    expect(focus.map((m) => m.workflowId)).not.toContain("wf_struct")
  })

  it("indexes trigger.pet.event and matches by the kinds filter", () => {
    _seedTriggerSubscriptionsForTest([
      wf("wf_any", [trigger("n", "trigger.pet.event", {})]),
      wf("wf_unwell", [trigger("n", "trigger.pet.event", { kinds: ["unwell"] })]),
      wf("wf_level", [trigger("n", "trigger.pet.event", { kinds: ["levelUp", "evolved"] })]),
    ])
    expect(_peekTriggerSubscriptions().get("trigger.pet.event")).toHaveLength(3)

    const unwell = findMatchingWorkflows("trigger.pet.event", { petEventKind: "unwell" })
    expect(unwell.map((m) => m.workflowId)).toEqual(expect.arrayContaining(["wf_any", "wf_unwell"]))
    expect(unwell.map((m) => m.workflowId)).not.toContain("wf_level")

    const level = findMatchingWorkflows("trigger.pet.event", { petEventKind: "levelUp" })
    expect(level.map((m) => m.workflowId)).toEqual(expect.arrayContaining(["wf_any", "wf_level"]))
  })

  it("indexes terminal.command and matches by session / project / status / substring", () => {
    _seedTriggerSubscriptionsForTest([
      wf("wf_any", [trigger("n", "trigger.terminal.command", {})]),
      wf("wf_sess", [trigger("n", "trigger.terminal.command", { sessionId: "tab-1" })]),
      wf("wf_proj", [trigger("n", "trigger.terminal.command", { projectId: "proj-1" })]),
      wf("wf_fail", [trigger("n", "trigger.terminal.command", { status: "failure" })]),
      wf("wf_sub", [trigger("n", "trigger.terminal.command", { commandContains: "pnpm test" })]),
    ])
    expect(_peekTriggerSubscriptions().get("trigger.terminal.command")).toHaveLength(5)

    const all = findMatchingWorkflows("trigger.terminal.command", {
      sessionId: "tab-1",
      projectId: "proj-1",
      status: "failure",
      command: "pnpm test -- --coverage",
    })
    expect(all.map((m) => m.workflowId)).toEqual(
      expect.arrayContaining(["wf_any", "wf_sess", "wf_proj", "wf_fail", "wf_sub"])
    )

    // A successful command in another tab/project: only the unscoped node fires.
    const other = findMatchingWorkflows("trigger.terminal.command", {
      sessionId: "tab-2",
      projectId: "proj-2",
      status: "success",
      command: "git status",
    })
    expect(other.map((m) => m.workflowId)).toEqual(["wf_any"])
  })

  it("a commandContains filter never matches a redacted (empty) command", () => {
    _seedTriggerSubscriptionsForTest([
      wf("wf_sub", [trigger("n", "trigger.terminal.command", { commandContains: "deploy" })]),
      wf("wf_any", [trigger("n", "trigger.terminal.command", {})]),
    ])
    const matches = findMatchingWorkflows("trigger.terminal.command", {
      sessionId: "tab-1",
      status: "success",
      command: "",
    })
    expect(matches.map((m) => m.workflowId)).toEqual(["wf_any"])
  })

  it("indexes trigger.workflow.completed and scopes by source workflow + status", () => {
    _seedTriggerSubscriptionsForTest([
      wf("wf_b", [trigger("n", "trigger.workflow.completed", { workflowId: "wf_a" })]),
      wf("wf_c", [
        trigger("n", "trigger.workflow.completed", { workflowId: "wf_a", status: "succeeded" }),
      ]),
      wf("wf_d", [trigger("n", "trigger.workflow.completed", { workflowId: "wf_other" })]),
      wf("wf_any", [trigger("n", "trigger.workflow.completed", {})]),
    ])

    // Success of wf_a: scoped-any-status + scoped-succeeded + unscoped match.
    const success = findMatchingWorkflows("trigger.workflow.completed", {
      sourceWorkflowId: "wf_a",
      status: "succeeded",
    })
    expect(success.map((m) => m.workflowId).sort()).toEqual(["wf_any", "wf_b", "wf_c"])

    // Failure of wf_a: the succeeded-only node drops out.
    const failure = findMatchingWorkflows("trigger.workflow.completed", {
      sourceWorkflowId: "wf_a",
      status: "failed",
    })
    expect(failure.map((m) => m.workflowId).sort()).toEqual(["wf_any", "wf_b"])
  })

  it("returns an empty array when nothing matches or cache is empty", () => {
    expect(findMatchingWorkflows("trigger.chat.message", {})).toEqual([])
    _seedTriggerSubscriptionsForTest([])
    expect(findMatchingWorkflows("trigger.chat.message", { characterId: "x" })).toEqual([])
  })

  it("disposeTriggerSubscriptions clears the cache", () => {
    _seedTriggerSubscriptionsForTest([wf("wf", [trigger("n", "trigger.chat.message", {})])])
    expect(findMatchingWorkflows("trigger.chat.message", {}).length).toBeGreaterThan(0)
    disposeTriggerSubscriptions()
    expect(findMatchingWorkflows("trigger.chat.message", {})).toEqual([])
  })
})
