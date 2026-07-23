import { KNOWN_KINDS, PARAMS_SCHEMAS, paramsSchemaFor } from "./params-schemas"
import type { WorkflowNodeKind } from "@/types/workflow/visual"

describe("PARAMS_SCHEMAS coverage", () => {
  it("registers a schema for every known kind", () => {
    for (const kind of KNOWN_KINDS) {
      expect(PARAMS_SCHEMAS[kind]).toBeDefined()
    }
  })

  it("returns a permissive fallback for unknown kinds", () => {
    const schema = paramsSchemaFor("plugin.foo.bar" as WorkflowNodeKind)
    const result = schema.safeParse({ anything: 1, nested: { x: true } })
    expect(result.success).toBe(true)
  })
})

describe("WORKFLOW_NODE_KINDS ↔ PARAMS_SCHEMAS parity", () => {
  // `PARAMS_SCHEMAS` is declared with `satisfies Record<WorkflowNodeKind, …>`,
  // so its key set is compile-enforced to equal the `WorkflowNodeKind` union
  // exactly. Asserting the hand-maintained `WORKFLOW_NODE_KINDS` array matches
  // those keys transitively pins the array to the union — closing the one drift
  // the type system can't catch on its own: a kind added to the union (and thus
  // forced into the schema map + catalog) but forgotten in the array, or a stale
  // entry left in the array.
  it("the kinds array lists exactly the schema-mapped kinds", () => {
    const arrayKinds = [...new Set<string>(KNOWN_KINDS)].sort()
    const schemaKinds = [...new Set<string>(Object.keys(PARAMS_SCHEMAS))].sort()
    expect(arrayKinds).toEqual(schemaKinds)
  })
})

describe("trigger schemas", () => {
  it("trigger.cron requires a 5-field expression", () => {
    expect(PARAMS_SCHEMAS["trigger.cron"].safeParse({ cron: "" }).success).toBe(false)
    expect(PARAMS_SCHEMAS["trigger.cron"].safeParse({ cron: "every monday" }).success).toBe(false)
    expect(PARAMS_SCHEMAS["trigger.cron"].safeParse({ cron: "0 9 * * 1-5" }).success).toBe(true)
    expect(
      PARAMS_SCHEMAS["trigger.cron"].safeParse({ cron: "0 9 * * 1-5", timezone: "UTC" }).success
    ).toBe(true)
  })

  it("action.team.task.dispatch enforces non-empty string fields (regression: requiredString was uncalled)", () => {
    const schema = PARAMS_SCHEMAS["action.team.task.dispatch"]
    // Missing required fields must fail.
    expect(schema.safeParse({}).success).toBe(false)
    expect(schema.safeParse({ teamId: "t", taskId: "k", title: "x" }).success).toBe(false)
    // Empty strings must fail (the bug let these through as a Zod function type).
    expect(
      schema.safeParse({ teamId: "", taskId: "k", title: "x", description: "d" }).success
    ).toBe(false)
    // Fully populated passes; expectedOutput stays optional.
    expect(
      schema.safeParse({ teamId: "t", taskId: "k", title: "x", description: "d" }).success
    ).toBe(true)
  })

  it("io.http rejects a non-URL but accepts URLs and {{ expressions }}", () => {
    const schema = PARAMS_SCHEMAS["io.http"]
    expect(schema.safeParse({ url: "not a url" }).success).toBe(false)
    expect(schema.safeParse({ url: "https://api.example.com/x" }).success).toBe(true)
    expect(schema.safeParse({ url: "{{ $vars.base }}/x" }).success).toBe(true)
  })

  it("action.twin.ingest validates the optional URL when present", () => {
    const schema = PARAMS_SCHEMAS["action.twin.ingest"]
    expect(schema.safeParse({ twinId: "t", sourceMode: "fetch", url: "ftp://nope" }).success).toBe(
      false
    )
    expect(
      schema.safeParse({ twinId: "t", sourceMode: "fetch", url: "https://ok.test/page" }).success
    ).toBe(true)
  })

  it("trigger.connector.inbound requires adapterId", () => {
    expect(PARAMS_SCHEMAS["trigger.connector.inbound"].safeParse({}).success).toBe(false)
    expect(PARAMS_SCHEMAS["trigger.connector.inbound"].safeParse({ adapterId: "tg" }).success).toBe(
      true
    )
  })

  it("trigger.chat.message requires characterId", () => {
    expect(PARAMS_SCHEMAS["trigger.chat.message"].safeParse({}).success).toBe(false)
    expect(
      PARAMS_SCHEMAS["trigger.chat.message"].safeParse({ characterId: "char_1" }).success
    ).toBe(true)
  })

  it("trigger.webhook validates path and status range", () => {
    expect(PARAMS_SCHEMAS["trigger.webhook"].safeParse({ path: "" }).success).toBe(false)
    expect(PARAMS_SCHEMAS["trigger.webhook"].safeParse({ path: "INVALID PATH" }).success).toBe(
      false
    )
    expect(PARAMS_SCHEMAS["trigger.webhook"].safeParse({ path: "incoming" }).success).toBe(true)
    expect(
      PARAMS_SCHEMAS["trigger.webhook"].safeParse({ path: "x", responseStatus: 99 }).success
    ).toBe(false)
    expect(
      PARAMS_SCHEMAS["trigger.webhook"].safeParse({ path: "x", responseStatus: 200 }).success
    ).toBe(true)
  })

  it("trigger.manual is unconditionally happy", () => {
    expect(PARAMS_SCHEMAS["trigger.manual"].safeParse({}).success).toBe(true)
  })
})

describe("action: character/team/skill schemas", () => {
  it("action.character.send requires characterId + content", () => {
    expect(PARAMS_SCHEMAS["action.character.send"].safeParse({}).success).toBe(false)
    expect(
      PARAMS_SCHEMAS["action.character.send"].safeParse({ characterId: "x", content: "hi" }).success
    ).toBe(true)
  })

  it("action.character.create requires name + systemPrompt", () => {
    expect(PARAMS_SCHEMAS["action.character.create"].safeParse({ name: "x" }).success).toBe(false)
    expect(
      PARAMS_SCHEMAS["action.character.create"].safeParse({ name: "x", systemPrompt: "s" }).success
    ).toBe(true)
  })

  it("action.character.update requires characterId", () => {
    expect(PARAMS_SCHEMAS["action.character.update"].safeParse({}).success).toBe(false)
    expect(PARAMS_SCHEMAS["action.character.update"].safeParse({ characterId: "c" }).success).toBe(
      true
    )
  })

  it("action.team.run requires teamId + goal", () => {
    expect(PARAMS_SCHEMAS["action.team.run"].safeParse({ teamId: "t" }).success).toBe(false)
    expect(PARAMS_SCHEMAS["action.team.run"].safeParse({ teamId: "t", goal: "go" }).success).toBe(
      true
    )
  })

  it("action.team.create requires name", () => {
    expect(PARAMS_SCHEMAS["action.team.create"].safeParse({}).success).toBe(false)
    expect(PARAMS_SCHEMAS["action.team.create"].safeParse({ name: "T" }).success).toBe(true)
  })

  it("action.team.update requires teamId", () => {
    expect(PARAMS_SCHEMAS["action.team.update"].safeParse({}).success).toBe(false)
    expect(PARAMS_SCHEMAS["action.team.update"].safeParse({ teamId: "t" }).success).toBe(true)
  })

  it("action.plan.create requires a session, title, and explicit steps", () => {
    const schema = PARAMS_SCHEMAS["action.plan.create" as keyof typeof PARAMS_SCHEMAS]
    expect(schema?.safeParse({}).success).toBe(false)
    expect(
      schema?.safeParse({
        sessionId: "ses_1",
        title: "Ship the plan",
        stepsJson: '[{"title":"Do it","kind":"agent_turn"}]',
      }).success
    ).toBe(true)
    expect(
      schema?.safeParse({
        sessionId: "ses_1",
        title: "Ship the plan",
        steps: [{ title: "Do it", kind: "agent_turn" }],
      }).success
    ).toBe(true)
  })

  it("action.plan list/events/lifecycle schemas enforce required targeting fields", () => {
    expect(
      PARAMS_SCHEMAS["action.plan.list" as keyof typeof PARAMS_SCHEMAS]?.safeParse({
        mode: "session",
      }).success
    ).toBe(false)
    expect(
      PARAMS_SCHEMAS["action.plan.list" as keyof typeof PARAMS_SCHEMAS]?.safeParse({
        mode: "session",
        sessionId: "ses_1",
      }).success
    ).toBe(true)
    expect(
      PARAMS_SCHEMAS["action.plan.events" as keyof typeof PARAMS_SCHEMAS]?.safeParse({
        limit: 10,
      }).success
    ).toBe(false)
    expect(
      PARAMS_SCHEMAS["action.plan.approve" as keyof typeof PARAMS_SCHEMAS]?.safeParse({
        planId: "plan_1",
      }).success
    ).toBe(true)
    expect(
      PARAMS_SCHEMAS["action.plan.reject" as keyof typeof PARAMS_SCHEMAS]?.safeParse({
        planId: "plan_1",
        feedback: "Needs a smaller scope",
      }).success
    ).toBe(true)
    expect(
      PARAMS_SCHEMAS["action.plan.refine" as keyof typeof PARAMS_SCHEMAS]?.safeParse({
        planId: "plan_1",
        refinementType: "repair",
        trigger: "step_failure",
        failedStepId: "step_1",
      }).success
    ).toBe(true)
  })

  it("action.plan.updateDraft and setStepStatus validate patch intent", () => {
    expect(
      PARAMS_SCHEMAS["action.plan.updateDraft" as keyof typeof PARAMS_SCHEMAS]?.safeParse({
        planId: "plan_1",
      }).success
    ).toBe(false)
    expect(
      PARAMS_SCHEMAS["action.plan.updateDraft" as keyof typeof PARAMS_SCHEMAS]?.safeParse({
        planId: "plan_1",
        title: "Updated plan",
      }).success
    ).toBe(true)
    expect(
      PARAMS_SCHEMAS["action.plan.setStepStatus" as keyof typeof PARAMS_SCHEMAS]?.safeParse({
        planId: "plan_1",
        stepId: "step_1",
        status: "completed",
      }).success
    ).toBe(true)
    expect(
      PARAMS_SCHEMAS["action.plan.setStepStatus" as keyof typeof PARAMS_SCHEMAS]?.safeParse({
        planId: "plan_1",
        stepId: "step_1",
        status: "unknown",
      }).success
    ).toBe(false)
  })

  it("scheduler task schemas validate task lifecycle fields", () => {
    expect(
      PARAMS_SCHEMAS["action.scheduler.task.create" as WorkflowNodeKind].safeParse({
        name: "Nightly agent",
        type: "agent",
        triggerType: "cron",
        cronExpression: "0 1 * * *",
        payloadJson: '{"prompt":"check status","characterId":"char_1"}',
      }).success
    ).toBe(true)
    expect(
      PARAMS_SCHEMAS["action.scheduler.task.create" as WorkflowNodeKind].safeParse({
        name: "Missing trigger",
        type: "custom",
        triggerType: "cron",
      }).success
    ).toBe(false)
    expect(
      PARAMS_SCHEMAS["action.scheduler.task.create" as WorkflowNodeKind].safeParse({
        name: "Once",
        type: "custom",
        triggerType: "once",
        runAt: "2026-12-31T00:00:00Z",
      }).success
    ).toBe(true)

    for (const kind of [
      "action.scheduler.task.get",
      "action.scheduler.task.pause",
      "action.scheduler.task.resume",
      "action.scheduler.task.delete",
      "action.scheduler.task.runNow",
      "action.scheduler.task.executions",
    ] as WorkflowNodeKind[]) {
      expect(PARAMS_SCHEMAS[kind].safeParse({}).success).toBe(false)
      expect(PARAMS_SCHEMAS[kind].safeParse({ taskId: "task_1" }).success).toBe(true)
    }

    expect(
      PARAMS_SCHEMAS["action.scheduler.task.list" as WorkflowNodeKind].safeParse({
        statuses: ["active", "paused"],
        types: ["agent", "script"],
        tags: ["nightly"],
        limit: 25,
      }).success
    ).toBe(true)
    expect(
      PARAMS_SCHEMAS["action.scheduler.task.update" as WorkflowNodeKind].safeParse({
        taskId: "task_1",
      }).success
    ).toBe(false)
    expect(
      PARAMS_SCHEMAS["action.scheduler.task.update" as WorkflowNodeKind].safeParse({
        taskId: "task_1",
        status: "paused",
      }).success
    ).toBe(true)
  })

  it("advanced scheduler schemas validate import/export, backfill, status, and event fields", () => {
    expect(
      PARAMS_SCHEMAS["action.scheduler.task.backfill" as WorkflowNodeKind].safeParse({
        taskId: "task_1",
        start: "2026-06-01T00:00:00Z",
        end: "2026-06-02T00:00:00Z",
      }).success
    ).toBe(true)
    expect(
      PARAMS_SCHEMAS["action.scheduler.task.backfill" as WorkflowNodeKind].safeParse({
        taskId: "task_1",
        start: "2026-06-01T00:00:00Z",
      }).success
    ).toBe(false)

    expect(
      PARAMS_SCHEMAS["action.scheduler.task.export" as WorkflowNodeKind].safeParse({
        taskIdsRaw: "task_1, task_2",
      }).success
    ).toBe(true)
    expect(
      PARAMS_SCHEMAS["action.scheduler.task.import" as WorkflowNodeKind].safeParse({
        dataJson: '{"version":1,"tasks":[]}',
        mode: "replace",
      }).success
    ).toBe(true)
    expect(
      PARAMS_SCHEMAS["action.scheduler.task.import" as WorkflowNodeKind].safeParse({
        mode: "replace",
      }).success
    ).toBe(false)

    for (const kind of [
      "action.scheduler.status",
      "action.scheduler.statistics",
    ] as WorkflowNodeKind[]) {
      expect(PARAMS_SCHEMAS[kind].safeParse({}).success).toBe(true)
    }
    expect(
      PARAMS_SCHEMAS["action.scheduler.upcoming" as WorkflowNodeKind].safeParse({
        limit: 25,
      }).success
    ).toBe(true)
    expect(
      PARAMS_SCHEMAS["action.scheduler.executions.recent" as WorkflowNodeKind].safeParse({
        limit: 25,
      }).success
    ).toBe(true)
    expect(
      PARAMS_SCHEMAS["action.scheduler.execution.get" as WorkflowNodeKind].safeParse({}).success
    ).toBe(false)
    expect(
      PARAMS_SCHEMAS["action.scheduler.execution.get" as WorkflowNodeKind].safeParse({
        executionId: "exec_1",
      }).success
    ).toBe(true)
    expect(
      PARAMS_SCHEMAS["action.scheduler.event.trigger" as WorkflowNodeKind].safeParse({
        eventType: "goal:completed",
        eventSource: "goal",
        payloadJson: '{"goalId":"goal_1"}',
      }).success
    ).toBe(true)
    expect(
      PARAMS_SCHEMAS["action.scheduler.event.trigger" as WorkflowNodeKind].safeParse({
        eventSource: "goal",
      }).success
    ).toBe(false)
  })

  it("action.skill.invoke requires skillIds string", () => {
    expect(PARAMS_SCHEMAS["action.skill.invoke"].safeParse({}).success).toBe(false)
    expect(PARAMS_SCHEMAS["action.skill.invoke"].safeParse({ skillIds: "skill_a" }).success).toBe(
      true
    )
  })

  it("action.skill.upsert requires name + content", () => {
    expect(PARAMS_SCHEMAS["action.skill.upsert"].safeParse({ name: "x" }).success).toBe(false)
    expect(
      PARAMS_SCHEMAS["action.skill.upsert"].safeParse({ name: "x", content: "body" }).success
    ).toBe(true)
  })
})

describe("memory action schemas", () => {
  it("accepts all four scopes and the complete namespace fields", () => {
    for (const scope of ["global", "workspace", "character", "agent"]) {
      expect(
        PARAMS_SCHEMAS["action.memory.recall"].safeParse({
          query: "tooling",
          scope,
          projectId: "p1",
          characterId: "c1",
          agentId: "a1",
          branch: "main",
          path: "src",
        }).success
      ).toBe(true)
      expect(
        PARAMS_SCHEMAS["action.memory.store"].safeParse({
          text: "The project uses pnpm",
          scope,
          projectId: "p1",
          characterId: "c1",
          agentId: "a1",
          branch: "main",
          pathPattern: "src",
        }).success
      ).toBe(true)
    }
  })

  it("rejects unknown scopes and invalid namespace value types", () => {
    expect(
      PARAMS_SCHEMAS["action.memory.recall"].safeParse({ query: "x", scope: "team" }).success
    ).toBe(false)
    expect(
      PARAMS_SCHEMAS["action.memory.store"].safeParse({ text: "x", projectId: 42 }).success
    ).toBe(false)
  })
})

describe("action: goal schemas", () => {
  it("action.goal.create requires sessionId + rawObjective and accepts configJson", () => {
    const s = PARAMS_SCHEMAS["action.goal.create" as WorkflowNodeKind]
    expect(s.safeParse({}).success).toBe(false)
    expect(s.safeParse({ sessionId: "ses_1", rawObjective: "ship it" }).success).toBe(true)
    expect(
      s.safeParse({
        sessionId: "ses_1",
        rawObjective: "ship it",
        startPaused: true,
        configJson: '{"maxTurns":5}',
      }).success
    ).toBe(true)
  })

  it("goal id actions require goalId", () => {
    for (const kind of [
      "action.goal.get",
      "action.goal.events",
      "action.goal.pause",
      "action.goal.resume",
      "action.goal.stop",
      "action.goal.preempt",
      "action.goal.decomposeSubgoals",
      "action.goal.clearSubgoals",
      "action.goal.delete",
    ] as WorkflowNodeKind[]) {
      expect(PARAMS_SCHEMAS[kind].safeParse({}).success).toBe(false)
      expect(PARAMS_SCHEMAS[kind].safeParse({ goalId: "goal_1" }).success).toBe(true)
    }
  })

  it("action.goal.updateObjective and toggleSubgoal require their editable fields", () => {
    expect(
      PARAMS_SCHEMAS["action.goal.updateObjective" as WorkflowNodeKind].safeParse({
        goalId: "goal_1",
      }).success
    ).toBe(false)
    expect(
      PARAMS_SCHEMAS["action.goal.updateObjective" as WorkflowNodeKind].safeParse({
        goalId: "goal_1",
        rawObjective: "new objective",
      }).success
    ).toBe(true)
    expect(
      PARAMS_SCHEMAS["action.goal.toggleSubgoal" as WorkflowNodeKind].safeParse({
        goalId: "goal_1",
      }).success
    ).toBe(false)
    expect(
      PARAMS_SCHEMAS["action.goal.toggleSubgoal" as WorkflowNodeKind].safeParse({
        goalId: "goal_1",
        subgoalId: "sub_1",
      }).success
    ).toBe(true)
  })

  it("action.goal.list and action.goal.analytics require sessionId only in session scope", () => {
    const list = PARAMS_SCHEMAS["action.goal.list" as WorkflowNodeKind]
    expect(list.safeParse({ mode: "all" }).success).toBe(true)
    expect(list.safeParse({ mode: "session" }).success).toBe(false)
    expect(list.safeParse({ mode: "session", sessionId: "ses_1", limit: 10 }).success).toBe(true)
    const analytics = PARAMS_SCHEMAS["action.goal.analytics" as WorkflowNodeKind]
    expect(analytics.safeParse({ scope: "all", windowDays: 30 }).success).toBe(true)
    expect(analytics.safeParse({ scope: "session" }).success).toBe(false)
    expect(analytics.safeParse({ scope: "session", sessionId: "ses_1" }).success).toBe(true)
  })

  it("action.goal.template nodes validate template ids and editable template fields", () => {
    expect(
      PARAMS_SCHEMAS["action.goal.template.createGoal" as WorkflowNodeKind].safeParse({
        templateId: "gtpl_1",
        sessionId: "ses_1",
      }).success
    ).toBe(true)
    expect(
      PARAMS_SCHEMAS["action.goal.template.createGoal" as WorkflowNodeKind].safeParse({
        templateId: "gtpl_1",
      }).success
    ).toBe(false)

    const upsert = PARAMS_SCHEMAS["action.goal.template.upsert" as WorkflowNodeKind]
    expect(upsert.safeParse({ title: "x" }).success).toBe(false)
    expect(
      upsert.safeParse({
        title: "x",
        objectiveText: "do the work",
        configJson: '{"maxTurns":4}',
        sortOrder: 1,
      }).success
    ).toBe(true)

    expect(
      PARAMS_SCHEMAS["action.goal.template.favorite" as WorkflowNodeKind].safeParse({
        templateId: "gtpl_1",
        isFavorite: true,
      }).success
    ).toBe(true)
    expect(
      PARAMS_SCHEMAS["action.goal.template.delete" as WorkflowNodeKind].safeParse({}).success
    ).toBe(false)
  })
})

describe("action: twin / connector / mcp / plugin", () => {
  it("action.twin.rag requires twinId + query", () => {
    expect(PARAMS_SCHEMAS["action.twin.rag"].safeParse({ twinId: "t" }).success).toBe(false)
    expect(PARAMS_SCHEMAS["action.twin.rag"].safeParse({ twinId: "t", query: "q" }).success).toBe(
      true
    )
  })

  it("action.twin.rag enforces topK range", () => {
    expect(
      PARAMS_SCHEMAS["action.twin.rag"].safeParse({ twinId: "t", query: "q", topK: 0 }).success
    ).toBe(false)
    expect(
      PARAMS_SCHEMAS["action.twin.rag"].safeParse({ twinId: "t", query: "q", topK: 51 }).success
    ).toBe(false)
  })

  it("action.twin.ingest requires url in fetch mode and content in paste mode", () => {
    const s = PARAMS_SCHEMAS["action.twin.ingest"]
    expect(s.safeParse({ twinId: "t", sourceMode: "fetch" }).success).toBe(false)
    expect(s.safeParse({ twinId: "t", sourceMode: "fetch", url: "https://x.test" }).success).toBe(
      true
    )
    expect(s.safeParse({ twinId: "t", sourceMode: "paste" }).success).toBe(false)
    expect(s.safeParse({ twinId: "t", sourceMode: "paste", content: "x" }).success).toBe(true)
    // default mode = paste
    expect(s.safeParse({ twinId: "t" }).success).toBe(false)
  })

  it("action.connector.send requires adapterId, conversationKey, content", () => {
    const s = PARAMS_SCHEMAS["action.connector.send"]
    expect(s.safeParse({}).success).toBe(false)
    expect(s.safeParse({ adapterId: "tg", conversationKey: "k", content: "hi" }).success).toBe(true)
  })

  it("action.connector.send fine-grain: edit target + delivery-wait bounds", () => {
    const s = PARAMS_SCHEMAS["action.connector.send"]
    const base = { adapterId: "tg", conversationKey: "k", content: "hi" }
    expect(
      s.safeParse({
        ...base,
        editTargetMessageId: "om_1",
        waitForDelivery: true,
        waitTimeoutMs: 5_000,
      }).success
    ).toBe(true)
    // Wait budget is bounded to [100, 300000] at the schema layer.
    expect(s.safeParse({ ...base, waitTimeoutMs: 50 }).success).toBe(false)
    expect(s.safeParse({ ...base, waitTimeoutMs: 600_000 }).success).toBe(false)
    expect(s.safeParse({ ...base, waitForDelivery: "yes" }).success).toBe(false)
  })

  it("action.connector.draft requires conversationKey, sessionId, content", () => {
    const s = PARAMS_SCHEMAS["action.connector.draft"]
    expect(s.safeParse({}).success).toBe(false)
    expect(s.safeParse({ conversationKey: "k", sessionId: "s", content: "x" }).success).toBe(true)
  })

  it("action.mcp.invokeTool requires serverId + toolName", () => {
    const s = PARAMS_SCHEMAS["action.mcp.invokeTool"]
    expect(s.safeParse({}).success).toBe(false)
    expect(s.safeParse({ serverId: "s", toolName: "t" }).success).toBe(true)
  })

  it("action.plugin.invoke requires pluginId; taskId/toolName are per-mode optional", () => {
    const s = PARAMS_SCHEMAS["action.plugin.invoke"]
    expect(s.safeParse({}).success).toBe(false)
    // Legacy task-mode nodes (no mode discriminator).
    expect(s.safeParse({ pluginId: "p", taskId: "t" }).success).toBe(true)
    // Tool-mode nodes carry toolName instead of taskId.
    expect(s.safeParse({ pluginId: "p", mode: "tool", toolName: "demo" }).success).toBe(true)
    // Mode is constrained to the known discriminators.
    expect(s.safeParse({ pluginId: "p", mode: "bogus" }).success).toBe(false)
  })
})

describe("action: GitHub Delivery schemas", () => {
  const validCases: Array<[WorkflowNodeKind, Record<string, unknown>, Record<string, unknown>]> = [
    [
      "action.github.openPr",
      { repoFullName: "o/r", head: "feature/x", base: "main", title: "Open PR" },
      { repoFullName: "o/r", head: "feature/x", base: "main" },
    ],
    ["action.github.closePr", { repoFullName: "o/r", prNumber: 1 }, { repoFullName: "o/r" }],
    ["action.github.mergePr", { repoFullName: "o/r", prNumber: 1 }, { repoFullName: "o/r" }],
    [
      "action.github.reviewPr",
      { repoFullName: "o/r", prNumber: 1, event: "APPROVE", body: "LGTM" },
      { repoFullName: "o/r", prNumber: 1, event: "APPROVE" },
    ],
    [
      "action.github.reviewPrInline",
      { repoFullName: "o/r", prNumber: 1, provider: "openai", model: "gpt-4.1", apiKey: "sk" },
      { repoFullName: "o/r", prNumber: 1, provider: "openai", model: "gpt-4.1" },
    ],
    [
      "action.github.commentPr",
      { repoFullName: "o/r", prNumber: 1, body: "Thanks" },
      { repoFullName: "o/r", prNumber: 1 },
    ],
    [
      "action.github.commentIssue",
      { repoFullName: "o/r", issueNumber: 1, body: "Thanks" },
      { repoFullName: "o/r", issueNumber: 1 },
    ],
    [
      "action.github.labelIssue",
      { repoFullName: "o/r", issueNumber: 1, add: ["bug"] },
      { repoFullName: "o/r", issueNumber: 1 },
    ],
    ["action.github.closeIssue", { repoFullName: "o/r", issueNumber: 1 }, { repoFullName: "o/r" }],
    [
      "action.github.createRelease",
      { repoFullName: "o/r", tag: "v1.0.0" },
      { repoFullName: "o/r" },
    ],
    [
      "action.github.generateChangelog",
      { repoFullName: "o/r", since: "v1.0.0" },
      { repoFullName: "o/r" },
    ],
    [
      "action.github.pushTag",
      { repoFullName: "o/r", tag: "v1.0.0", sha: "deadbeef" },
      { repoFullName: "o/r", tag: "v1.0.0" },
    ],
    [
      "action.github.runIssueLoop",
      { repoFullName: "o/r", issueNumber: 1 },
      { repoFullName: "o/r" },
    ],
  ]

  it("requires repoFullName plus each node's executor-required fields", () => {
    for (const [kind, valid, missingSpecific] of validCases) {
      expect(PARAMS_SCHEMAS[kind].safeParse(valid).success).toBe(true)
      expect(PARAMS_SCHEMAS[kind].safeParse({}).success).toBe(false)
      expect(PARAMS_SCHEMAS[kind].safeParse({ ...valid, repoFullName: "" }).success).toBe(false)
      expect(PARAMS_SCHEMAS[kind].safeParse(missingSpecific).success).toBe(false)
    }
  })

  it("keeps GitHub enum, numeric, and list fields aligned with plugin executors", () => {
    expect(
      PARAMS_SCHEMAS["action.github.mergePr"].safeParse({
        repoFullName: "o/r",
        prNumber: 1,
        mergeMethod: "octopus",
      }).success
    ).toBe(false)
    expect(
      PARAMS_SCHEMAS["action.github.reviewPr"].safeParse({
        repoFullName: "o/r",
        prNumber: 1,
        event: "DISMISS",
        body: "x",
      }).success
    ).toBe(false)
    expect(
      PARAMS_SCHEMAS["action.github.closeIssue"].safeParse({
        repoFullName: "o/r",
        issueNumber: 1,
        reason: "duplicate",
      }).success
    ).toBe(false)
    expect(
      PARAMS_SCHEMAS["action.github.runIssueLoop"].safeParse({
        repoFullName: "o/r",
        issueNumber: 1,
        worktreeMode: "remote",
      }).success
    ).toBe(false)
    expect(
      PARAMS_SCHEMAS["action.github.reviewPrInline"].safeParse({
        repoFullName: "o/r",
        prNumber: 1,
        provider: "openai",
        model: "gpt-4.1",
        apiKey: "sk",
        maxFiles: 0,
      }).success
    ).toBe(false)
    expect(
      PARAMS_SCHEMAS["action.github.reviewPrInline"].safeParse({
        repoFullName: "o/r",
        prNumber: 1,
        provider: "openai",
        model: "gpt-4.1",
        apiKey: "sk",
        maxFiles: 30,
      }).success
    ).toBe(true)
    expect(
      PARAMS_SCHEMAS["action.github.labelIssue"].safeParse({
        repoFullName: "o/r",
        issueNumber: 1,
        add: [""],
      }).success
    ).toBe(false)
    expect(
      PARAMS_SCHEMAS["action.github.labelIssue"].safeParse({
        repoFullName: "o/r",
        issueNumber: 1,
        remove: ["needs-info"],
      }).success
    ).toBe(true)
  })
})

describe("action: Desktop automation schemas", () => {
  it("validates desktop action required fields and executor enums", () => {
    expect(PARAMS_SCHEMAS["action.desktop.screenshot"].safeParse({ format: "webp" }).success).toBe(
      false
    )
    expect(
      PARAMS_SCHEMAS["action.desktop.screenshot"].safeParse({
        format: "png",
        region: { x: 0, y: 0, width: 640, height: 480 },
      }).success
    ).toBe(true)

    expect(
      PARAMS_SCHEMAS["action.desktop.click"].safeParse({ x: 10, y: 20, button: "primary" }).success
    ).toBe(false)
    expect(
      PARAMS_SCHEMAS["action.desktop.click"].safeParse({ selector: "Submit", button: "right" })
        .success
    ).toBe(true)

    expect(PARAMS_SCHEMAS["action.desktop.keys"].safeParse({}).success).toBe(false)
    expect(PARAMS_SCHEMAS["action.desktop.keys"].safeParse({ chord: "ctrl+shift+p" }).success).toBe(
      true
    )

    expect(PARAMS_SCHEMAS["action.desktop.paste"].safeParse({ text: "" }).success).toBe(false)
    expect(PARAMS_SCHEMAS["action.desktop.paste"].safeParse({ text: "hello" }).success).toBe(true)

    expect(PARAMS_SCHEMAS["action.desktop.launchApp"].safeParse({ app: "" }).success).toBe(false)
    expect(
      PARAMS_SCHEMAS["action.desktop.launchApp"].safeParse({ app: "notepad.exe", action: "focus" })
        .success
    ).toBe(true)
    expect(
      PARAMS_SCHEMAS["action.desktop.launchApp"].safeParse({
        app: "notepad.exe",
        action: "open",
      }).success
    ).toBe(false)
  })

  it("validates element-targeted desktop nodes without hiding direct runtime fields", () => {
    expect(
      PARAMS_SCHEMAS["action.desktop.invokePattern"].safeParse({ pattern: "toggle" }).success
    ).toBe(false)
    expect(
      PARAMS_SCHEMAS["action.desktop.invokePattern"].safeParse({
        selector: "Enable",
        pattern: "toggle",
        args: { state: "on" },
      }).success
    ).toBe(true)
    expect(
      PARAMS_SCHEMAS["action.desktop.invokePattern"].safeParse({
        target: "abc",
        pattern: "Toggle",
      }).success
    ).toBe(false)

    for (const kind of ["action.desktop.windowFocus", "action.desktop.windowClose"] as const) {
      expect(PARAMS_SCHEMAS[kind].safeParse({}).success).toBe(false)
      expect(PARAMS_SCHEMAS[kind].safeParse({ selector: "Main" }).success).toBe(true)
      expect(PARAMS_SCHEMAS[kind].safeParse({ target: "abc" }).success).toBe(true)
    }

    expect(PARAMS_SCHEMAS["action.desktop.windowResize"].safeParse({ target: "abc" }).success).toBe(
      false
    )
    expect(
      PARAMS_SCHEMAS["action.desktop.windowResize"].safeParse({
        selector: "Main",
        width: 1024,
        height: 768,
      }).success
    ).toBe(true)
    expect(
      PARAMS_SCHEMAS["action.desktop.windowResize"].safeParse({
        target: "abc",
        rect: { x: 0, y: 0, width: 800, height: 600 },
      }).success
    ).toBe(true)
  })

  it("validates desktop wait and trigger event fields", () => {
    expect(
      PARAMS_SCHEMAS["action.desktop.wait"].safeParse({
        selector: "Toast",
        mode: "appear",
        timeoutMs: 500,
        pollMs: 50,
      }).success
    ).toBe(true)
    expect(
      PARAMS_SCHEMAS["action.desktop.wait"].safeParse({ selector: "Toast", mode: "visible" })
        .success
    ).toBe(false)
    expect(
      PARAMS_SCHEMAS["trigger.desktop.event"].safeParse({ kinds: ["focus-changed"] }).success
    ).toBe(true)
    expect(PARAMS_SCHEMAS["trigger.desktop.event"].safeParse({ kinds: ["focus"] }).success).toBe(
      false
    )
  })
})

describe("ai schemas", () => {
  it("ai.prompt requires userPrompt", () => {
    expect(PARAMS_SCHEMAS["ai.prompt"].safeParse({}).success).toBe(false)
    expect(PARAMS_SCHEMAS["ai.prompt"].safeParse({ userPrompt: "go" }).success).toBe(true)
  })

  it("ai.prompt enforces temperature range", () => {
    expect(
      PARAMS_SCHEMAS["ai.prompt"].safeParse({ userPrompt: "x", temperature: -0.1 }).success
    ).toBe(false)
    expect(
      PARAMS_SCHEMAS["ai.prompt"].safeParse({ userPrompt: "x", temperature: 2.1 }).success
    ).toBe(false)
  })

  it("ai.prompt accepts explicit provider protocol metadata", () => {
    expect(
      PARAMS_SCHEMAS["ai.prompt"].safeParse({
        provider: "openrouter",
        model: "openai/gpt-4.1-mini",
        apiKey: "k",
        baseURL: "https://openrouter.ai/api/v1",
        apiFlavor: "chat",
        headers: { "HTTP-Referer": "https://cognia.local", "X-Title": "Cognia" },
        userPrompt: "x",
      }).success
    ).toBe(true)
    expect(
      PARAMS_SCHEMAS["ai.prompt"].safeParse({
        userPrompt: "x",
        apiFlavor: "legacy-completions",
      }).success
    ).toBe(false)
    expect(
      PARAMS_SCHEMAS["ai.prompt"].safeParse({
        userPrompt: "x",
        headers: { "X-Title": 123 },
      }).success
    ).toBe(false)
  })

  it("ai.classify requires input + labelsRaw", () => {
    const s = PARAMS_SCHEMAS["ai.classify"]
    expect(s.safeParse({}).success).toBe(false)
    expect(s.safeParse({ input: "x", labelsRaw: "a,b" }).success).toBe(true)
  })

  it("ai.classify accepts explicit provider protocol metadata", () => {
    const s = PARAMS_SCHEMAS["ai.classify"]
    expect(
      s.safeParse({
        provider: "openrouter",
        model: "openai/gpt-4.1-mini",
        apiKey: "k",
        baseURL: "https://openrouter.ai/api/v1",
        apiFlavor: "chat",
        headers: { "HTTP-Referer": "https://cognia.local", "X-Title": "Cognia" },
        input: "x",
        labelsRaw: "a,b",
      }).success
    ).toBe(true)
  })

  it("ai.extract requires input", () => {
    expect(PARAMS_SCHEMAS["ai.extract"].safeParse({}).success).toBe(false)
    expect(PARAMS_SCHEMAS["ai.extract"].safeParse({ input: "x" }).success).toBe(true)
  })

  it("ai.extract accepts explicit provider protocol metadata", () => {
    expect(
      PARAMS_SCHEMAS["ai.extract"].safeParse({
        provider: "openrouter",
        model: "openai/gpt-4.1-mini",
        apiKey: "k",
        baseURL: "https://openrouter.ai/api/v1",
        apiFlavor: "chat",
        headers: { "HTTP-Referer": "https://cognia.local", "X-Title": "Cognia" },
        input: "x",
      }).success
    ).toBe(true)
  })

  it("ai.embed requires input + dimension range", () => {
    const s = PARAMS_SCHEMAS["ai.embed"]
    expect(s.safeParse({}).success).toBe(false)
    expect(s.safeParse({ input: "x", dimension: 16 }).success).toBe(false)
    expect(s.safeParse({ input: "x", dimension: 384 }).success).toBe(true)
  })

  it("ai.browserModel validates operation-specific requirements", () => {
    const schema = PARAMS_SCHEMAS["ai.browserModel"]
    expect(schema.safeParse({ operation: "status" }).success).toBe(true)
    expect(schema.safeParse({ operation: "infer" }).success).toBe(false)
    expect(
      schema.safeParse({
        operation: "infer",
        task: "summarization",
        modelId: "Xenova/summary",
        input: "long text",
      }).success
    ).toBe(true)
  })
})

describe("flow schemas", () => {
  it("flow.branch requires condition", () => {
    expect(PARAMS_SCHEMAS["flow.branch"].safeParse({}).success).toBe(false)
    expect(PARAMS_SCHEMAS["flow.branch"].safeParse({ condition: "x === 1" }).success).toBe(true)
  })

  it("flow.switch requires subject and at least one case", () => {
    const s = PARAMS_SCHEMAS["flow.switch"]
    expect(s.safeParse({ subject: "x", cases: [] }).success).toBe(false)
    expect(s.safeParse({ subject: "x", cases: [{ value: "a", label: "A" }] }).success).toBe(true)
  })

  it("flow.split requires at least 2 branch labels", () => {
    expect(PARAMS_SCHEMAS["flow.split"].safeParse({ branchLabels: ["A"] }).success).toBe(false)
    expect(PARAMS_SCHEMAS["flow.split"].safeParse({ branchLabels: ["A", "B"] }).success).toBe(true)
  })

  it("flow.join is happy with defaults", () => {
    expect(PARAMS_SCHEMAS["flow.join"].safeParse({}).success).toBe(true)
  })

  it("flow.loop accepts the v2 container shape per mode", () => {
    const s = PARAMS_SCHEMAS["flow.loop"]
    expect(
      s.safeParse({ mode: "forEach", source: "{{ $node['n1'].items }}", output: "{{ $item }}" })
        .success
    ).toBe(true)
    expect(s.safeParse({ mode: "forEach" }).success).toBe(false)
    expect(s.safeParse({ mode: "times", times: 3, iterationConcurrency: 4 }).success).toBe(true)
    expect(s.safeParse({ mode: "times", times: "{{ $trigger.payload.n }}" }).success).toBe(true)
    expect(s.safeParse({ mode: "while", whileExpression: "{{ $static.go }}" }).success).toBe(true)
    expect(s.safeParse({ mode: "while" }).success).toBe(false)
  })

  it("flow.loop v2 scopes conditionTiming to while mode", () => {
    const s = PARAMS_SCHEMAS["flow.loop"]
    expect(
      s.safeParse({ mode: "while", whileExpression: "{{ $static.go }}", conditionTiming: "post" })
        .success
    ).toBe(true)
    expect(
      s.safeParse({ mode: "while", whileExpression: "{{ $static.go }}", conditionTiming: "pre" })
        .success
    ).toBe(true)
    expect(
      s.safeParse({ mode: "forEach", source: "{{ $x }}", conditionTiming: "post" }).success
    ).toBe(false)
    expect(s.safeParse({ mode: "times", times: 2, conditionTiming: "post" }).success).toBe(false)
    expect(
      s.safeParse({ mode: "while", whileExpression: "x", conditionTiming: "after" }).success
    ).toBe(false)
  })

  it("flow.loop v2 scopes batchSize to forEach mode and requires >= 1", () => {
    const s = PARAMS_SCHEMAS["flow.loop"]
    expect(s.safeParse({ mode: "forEach", source: "{{ $x }}", batchSize: 5 }).success).toBe(true)
    expect(s.safeParse({ mode: "forEach", source: "{{ $x }}", batchSize: 0 }).success).toBe(false)
    expect(s.safeParse({ mode: "forEach", source: "{{ $x }}", batchSize: -2 }).success).toBe(false)
    expect(s.safeParse({ mode: "times", times: 3, batchSize: 2 }).success).toBe(false)
    expect(s.safeParse({ mode: "while", whileExpression: "x", batchSize: 2 }).success).toBe(false)
  })

  it("flow.loop v2 accepts onItemError on every mode and rejects unknown values", () => {
    const s = PARAMS_SCHEMAS["flow.loop"]
    for (const policy of ["fail", "skip", "break"]) {
      expect(
        s.safeParse({ mode: "forEach", source: "{{ $x }}", onItemError: policy }).success
      ).toBe(true)
      expect(s.safeParse({ mode: "times", times: 3, onItemError: policy }).success).toBe(true)
      expect(
        s.safeParse({ mode: "while", whileExpression: "x", onItemError: policy }).success
      ).toBe(true)
    }
    expect(s.safeParse({ mode: "forEach", source: "{{ $x }}", onItemError: "retry" }).success).toBe(
      false
    )
  })

  it("flow.break / flow.continue accept empty params", () => {
    expect(PARAMS_SCHEMAS["flow.break"].safeParse({}).success).toBe(true)
    expect(PARAMS_SCHEMAS["flow.continue"].safeParse({}).success).toBe(true)
  })

  it("flow.branch accepts the v2 structured-conditions shape", () => {
    const s = PARAMS_SCHEMAS["flow.branch"]
    expect(
      s.safeParse({
        conditions: {
          combinator: "all",
          conditions: [{ left: "{{ $node['n1'].x }}", operator: "eq", right: "1" }],
        },
      }).success
    ).toBe(true)
    // Bad operator fails
    expect(
      s.safeParse({
        conditions: { combinator: "all", conditions: [{ left: "x", operator: "wat" }] },
      }).success
    ).toBe(false)
  })

  it("flow.switch accepts the v2 cases shape (id + when group)", () => {
    const s = PARAMS_SCHEMAS["flow.switch"]
    expect(
      s.safeParse({
        cases: [
          {
            id: "c_1",
            label: "One",
            when: {
              combinator: "any",
              conditions: [{ left: "{{ $trigger.payload.n }}", operator: "gt", right: "5" }],
            },
          },
        ],
      }).success
    ).toBe(true)
    // v2 with empty cases fails (needs at least one)
    expect(s.safeParse({ cases: [] }).success).toBe(false)
  })

  it("flow.loop requires bodyExpression and per-mode source", () => {
    const s = PARAMS_SCHEMAS["flow.loop"]
    // Missing body
    expect(s.safeParse({}).success).toBe(false)
    // Default mode = forEach: needs inputExpression
    expect(s.safeParse({ bodyExpression: "x" }).success).toBe(false)
    expect(s.safeParse({ bodyExpression: "x", inputExpression: "$node.a.out" }).success).toBe(true)
    // times mode: needs times > 0
    expect(s.safeParse({ bodyExpression: "x", mode: "times", times: 0 }).success).toBe(false)
    expect(s.safeParse({ bodyExpression: "x", mode: "times", times: 3 }).success).toBe(true)
    // while mode: needs whileCondition
    expect(s.safeParse({ bodyExpression: "x", mode: "while" }).success).toBe(false)
    expect(
      s.safeParse({ bodyExpression: "x", mode: "while", whileCondition: "true" }).success
    ).toBe(true)
  })

  it("flow.wait happy default", () => {
    expect(PARAMS_SCHEMAS["flow.wait"].safeParse({}).success).toBe(true)
  })

  it("flow.set rejects invalid identifier", () => {
    const s = PARAMS_SCHEMAS["flow.set"]
    expect(s.safeParse({ variable: "1bad", value: "x" }).success).toBe(false)
    expect(s.safeParse({ variable: "ok_name", value: "x" }).success).toBe(true)
    expect(s.safeParse({ variable: "ok_name", value: 1 }).success).toBe(true)
    expect(s.safeParse({ variable: "ok_name", value: false }).success).toBe(true)
    expect(s.safeParse({ variable: "ok_name", value: { nested: [1, null] } }).success).toBe(true)
    expect(s.safeParse({ variable: "ok_name" }).success).toBe(false)
  })

  it("accepts runtime expressions for GitHub issue and PR numbers", () => {
    expect(
      PARAMS_SCHEMAS["action.github.commentPr"].safeParse({
        repoFullName: "owner/repo",
        prNumber: "{{ $node.open.out.number }}",
        body: "done",
      }).success
    ).toBe(true)
    expect(
      PARAMS_SCHEMAS["action.github.commentIssue"].safeParse({
        repoFullName: "owner/repo",
        issueNumber: "not-an-expression",
        body: "done",
      }).success
    ).toBe(false)
  })

  it("flow.subworkflow requires workflowId", () => {
    expect(PARAMS_SCHEMAS["flow.subworkflow"].safeParse({}).success).toBe(false)
    expect(PARAMS_SCHEMAS["flow.subworkflow"].safeParse({ workflowId: "w" }).success).toBe(true)
  })
})

describe("data schemas", () => {
  it("data.transform requires expression", () => {
    expect(PARAMS_SCHEMAS["data.transform"].safeParse({}).success).toBe(false)
    expect(PARAMS_SCHEMAS["data.transform"].safeParse({ expression: "x" }).success).toBe(true)
  })

  it("data.code requires code", () => {
    expect(PARAMS_SCHEMAS["data.code"].safeParse({}).success).toBe(false)
    expect(PARAMS_SCHEMAS["data.code"].safeParse({ code: "return 1" }).success).toBe(true)
  })

  it("data.template requires template", () => {
    expect(PARAMS_SCHEMAS["data.template"].safeParse({}).success).toBe(false)
    expect(PARAMS_SCHEMAS["data.template"].safeParse({ template: "{{x}}" }).success).toBe(true)
  })
})

describe("io schemas", () => {
  it("io.http requires url", () => {
    expect(PARAMS_SCHEMAS["io.http"].safeParse({}).success).toBe(false)
    expect(PARAMS_SCHEMAS["io.http"].safeParse({ url: "https://x" }).success).toBe(true)
  })

  it("io.webhook.respond enforces status range", () => {
    const s = PARAMS_SCHEMAS["io.webhook.respond"]
    expect(s.safeParse({ status: 99 }).success).toBe(false)
    expect(s.safeParse({ status: 600 }).success).toBe(false)
    expect(s.safeParse({}).success).toBe(true)
    expect(s.safeParse({ status: 200 }).success).toBe(true)
  })
})

describe("annotation schemas", () => {
  it("annotation.note tolerates an empty body", () => {
    expect(PARAMS_SCHEMAS["annotation.note"].safeParse({}).success).toBe(true)
  })

  it("annotation.note rejects unknown color enum values", () => {
    expect(PARAMS_SCHEMAS["annotation.note"].safeParse({ color: "magenta" }).success).toBe(false)
  })

  it("annotation.group enforces min size", () => {
    const s = PARAMS_SCHEMAS["annotation.group"]
    expect(s.safeParse({ width: 100 }).success).toBe(false)
    expect(s.safeParse({ height: 50 }).success).toBe(false)
    expect(s.safeParse({}).success).toBe(true)
    expect(s.safeParse({ width: 480, height: 320 }).success).toBe(true)
  })
})

describe("trigger.workflow.completed schema", () => {
  const s = PARAMS_SCHEMAS["trigger.workflow.completed"]

  it("accepts an unscoped node (both params absent)", () => {
    expect(s.safeParse({}).success).toBe(true)
  })

  it("accepts the succeeded/failed outcomes AND the editor's empty-string any sentinel", () => {
    expect(s.safeParse({ status: "succeeded" }).success).toBe(true)
    expect(s.safeParse({ status: "failed" }).success).toBe(true)
    // patchParam stores "" rather than deleting — the enum must tolerate it.
    expect(s.safeParse({ status: "" }).success).toBe(true)
  })

  it("rejects unknown outcomes", () => {
    expect(s.safeParse({ status: "cancelled" }).success).toBe(false)
  })
})

describe("flow.wait event-mode schema", () => {
  const s = PARAMS_SCHEMAS["flow.wait"]

  it("accepts eventKey + timeoutMs alongside event mode", () => {
    expect(
      s.safeParse({ mode: "event", eventKey: "deploy-approved", timeoutMs: 60_000 }).success
    ).toBe(true)
  })

  it("rejects a negative timeout", () => {
    expect(s.safeParse({ mode: "event", timeoutMs: -1 }).success).toBe(false)
  })
})
