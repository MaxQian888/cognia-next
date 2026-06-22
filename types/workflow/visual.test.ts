import {
  WORKFLOW_NODE_KINDS,
  workflowNodeCategory,
  DEFAULT_WORKFLOW_SETTINGS,
  DEFAULT_RETRY_POLICY,
  type LoopNodeParams,
  type VisualWorkflowSchemaVersion,
  type WorkflowNodeKind,
  type WorkflowNodeSubcategory,
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
    expect(workflowNodeCategory("trigger.github.webhook")).toBe("trigger")
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

  it("includes the GitHub webhook trigger in the canonical trigger order", () => {
    const webhookIndex = WORKFLOW_NODE_KINDS.indexOf("trigger.webhook")
    const githubWebhookIndex = WORKFLOW_NODE_KINDS.indexOf("trigger.github.webhook")
    expect(webhookIndex).toBeGreaterThanOrEqual(0)
    expect(githubWebhookIndex).toBe(webhookIndex + 1)
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

  it("defaults new workflows to parallel ready-set scheduling", () => {
    // New workflows get in-run parallelism; persisted workflows WITHOUT the
    // field stay sequential via the orchestrator's `?? 1` fallback (covered
    // by orchestrator.test.ts "maxConcurrency=1 default serializes").
    expect(DEFAULT_WORKFLOW_SETTINGS.maxConcurrency).toBe(4)
  })

  it("retry policy default uses exponential backoff with a cap", () => {
    expect(DEFAULT_RETRY_POLICY.backoff).toBe("exponential")
    expect(DEFAULT_RETRY_POLICY.baseMs).toBeGreaterThan(0)
    expect(DEFAULT_RETRY_POLICY.maxMs).toBeGreaterThan(DEFAULT_RETRY_POLICY.baseMs)
  })
})

describe("phase 0 additions", () => {
  it("registers flow.break and flow.continue as flow-category kinds", () => {
    expect(WORKFLOW_NODE_KINDS).toContain("flow.break")
    expect(WORKFLOW_NODE_KINDS).toContain("flow.continue")
    expect(workflowNodeCategory("flow.break")).toBe("flow")
    expect(workflowNodeCategory("flow.continue")).toBe("flow")
  })

  it("accepts schemaVersion 2 and a loop-container param shape", () => {
    const v: VisualWorkflowSchemaVersion = 2
    const params: LoopNodeParams = {
      mode: "forEach",
      source: "{{ $node['n1'].items }}",
      output: "{{ $item.id }}",
      iterationConcurrency: 4,
      maxIterations: 1000,
    }
    expect(v).toBe(2)
    expect(params.mode).toBe("forEach")
  })

  it("exposes a subcategory type usable as a string tag", () => {
    const sub: WorkflowNodeSubcategory = "github"
    expect(sub).toBe("github")
  })
})
