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

  it("action.plugin.invoke requires pluginId + taskId", () => {
    const s = PARAMS_SCHEMAS["action.plugin.invoke"]
    expect(s.safeParse({}).success).toBe(false)
    expect(s.safeParse({ pluginId: "p", taskId: "t" }).success).toBe(true)
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

  it("ai.classify requires input + labelsRaw", () => {
    const s = PARAMS_SCHEMAS["ai.classify"]
    expect(s.safeParse({}).success).toBe(false)
    expect(s.safeParse({ input: "x", labelsRaw: "a,b" }).success).toBe(true)
  })

  it("ai.extract requires input", () => {
    expect(PARAMS_SCHEMAS["ai.extract"].safeParse({}).success).toBe(false)
    expect(PARAMS_SCHEMAS["ai.extract"].safeParse({ input: "x" }).success).toBe(true)
  })

  it("ai.embed requires input + dimension range", () => {
    const s = PARAMS_SCHEMAS["ai.embed"]
    expect(s.safeParse({}).success).toBe(false)
    expect(s.safeParse({ input: "x", dimension: 16 }).success).toBe(false)
    expect(s.safeParse({ input: "x", dimension: 384 }).success).toBe(true)
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
