import {
  WORKFLOW_NODE_KINDS,
  workflowNodeCategory,
  DEFAULT_WORKFLOW_SETTINGS,
  DEFAULT_RETRY_POLICY,
  type WorkflowNodeKind,
} from "./visual"

describe("workflowNodeCategory", () => {
  it("classifies every kind in the master list", () => {
    for (const kind of WORKFLOW_NODE_KINDS) {
      const category = workflowNodeCategory(kind)
      expect(category).toMatch(/^(trigger|action|ai|flow|data|io|annotation)$/)
    }
  })

  it("maps each known prefix to the matching category", () => {
    expect(workflowNodeCategory("trigger.cron")).toBe("trigger")
    expect(workflowNodeCategory("action.character.send")).toBe("action")
    expect(workflowNodeCategory("ai.prompt")).toBe("ai")
    expect(workflowNodeCategory("flow.branch")).toBe("flow")
    expect(workflowNodeCategory("data.transform")).toBe("data")
    expect(workflowNodeCategory("io.http")).toBe("io")
    expect(workflowNodeCategory("annotation.note")).toBe("annotation")
  })

  it("falls back to annotation for unknown prefixes", () => {
    // Plugin-contributed kinds that don't match a built-in prefix should not
    // crash; they're treated as annotations until the registry resolves them.
    expect(workflowNodeCategory("custom.plugin.thing" as WorkflowNodeKind)).toBe("annotation")
  })
})

describe("WORKFLOW_NODE_KINDS", () => {
  it("contains no duplicates", () => {
    const seen = new Set<string>()
    for (const k of WORKFLOW_NODE_KINDS) {
      expect(seen.has(k)).toBe(false)
      seen.add(k)
    }
  })

  it("covers all known categories", () => {
    const cats = new Set(WORKFLOW_NODE_KINDS.map(workflowNodeCategory))
    for (const required of ["trigger", "action", "ai", "flow", "data", "io", "annotation"]) {
      expect(cats.has(required as ReturnType<typeof workflowNodeCategory>)).toBe(true)
    }
  })
})

describe("default constants", () => {
  it("ships sane workflow defaults", () => {
    expect(DEFAULT_WORKFLOW_SETTINGS.errorPolicy).toBe("stop")
    expect(DEFAULT_WORKFLOW_SETTINGS.timeoutMs).toBeGreaterThan(0)
    expect(DEFAULT_WORKFLOW_SETTINGS.concurrency).toBeGreaterThanOrEqual(1)
    expect(DEFAULT_WORKFLOW_SETTINGS.retryDefaults.attempts).toBeGreaterThanOrEqual(1)
  })

  it("retry policy default uses exponential backoff with a cap", () => {
    expect(DEFAULT_RETRY_POLICY.backoff).toBe("exponential")
    expect(DEFAULT_RETRY_POLICY.baseMs).toBeGreaterThan(0)
    expect(DEFAULT_RETRY_POLICY.maxMs).toBeGreaterThan(DEFAULT_RETRY_POLICY.baseMs)
  })
})
