import type { PluginAgentConfigAPI } from "@cognia/plugin-sdk"

import type { RuleCheck } from "../adherence/checks"
import { DEFAULT_GOVERNANCE_CONFIG, type GovernanceConfig } from "../config"
import type { Finding } from "../model"
import { PROMPT_IDS } from "../prompts"
import {
  GovernanceBusyError,
  GovernanceRuntime,
  hasPromptCenterEntry,
  knownFinding,
  promptCenterHref,
  type GovernanceHost,
  WITHHELD_TEXT,
} from "./runtime"
import type { StorageLike } from "./store"

const CLAUDE_KEY = "instruction-file:/r/CLAUDE.md"

function memory(): StorageLike {
  const data = new Map<string, unknown>()
  return {
    get: async <T>(key: string) => data.get(key) as T | undefined,
    set: async <T>(key: string, value: T) => {
      data.set(key, JSON.parse(JSON.stringify(value)))
    },
    remove: async (key: string) => {
      data.delete(key)
    },
  }
}

interface Fixture {
  host: GovernanceHost
  texts: Record<string, string>
  config: GovernanceConfig
  agentConfig: PluginAgentConfigAPI & { applyEdit: jest.Mock }
  notify: jest.Mock
  navigate: jest.Mock
  runEval: jest.Mock
  chatAnswer: { value: string; calls: number }
  messages: Record<string, unknown[]>
  sessions: Array<{ id: string; projectId?: string; createdAt: number }>
}

function fixture(): Fixture {
  const texts: Record<string, string> = {
    [CLAUDE_KEY]: "# Rules\n- See `lib/gone.ts`.\n- Never run `git push --force`.",
  }
  const config = { ...DEFAULT_GOVERNANCE_CONFIG }
  const chatAnswer = { value: '{"findings":[]}', calls: 0 }
  const messages: Record<string, unknown[]> = {}
  const sessions: Fixture["sessions"] = []
  let id = 0
  let clock = 1_000
  const agentConfig = {
    listSurfaces: jest.fn(async () => ({
      workspaceId: "w",
      failed: [],
      surfaces: Object.keys(texts).map((key) => ({
        key,
        source: "instruction-file",
        kind: "instructions",
        name: key.split("/").pop(),
        builtIn: false,
        modified: false,
        edit: "source",
      })),
    })),
    readSurface: jest.fn(async (key: string) =>
      key in texts ? { key, text: texts[key]!, version: `v:${texts[key]!.length}` } : null
    ),
    readFacts: jest.fn(async () => ({
      hooksAvailable: false,
      hooks: [],
      permissionRules: [],
      mcpServers: [],
      skills: { total: 0, enabled: 0, builtIn: 0 },
      instructions: {},
    })),
    checkReferences: jest.fn(async (input: { paths?: string[] }) => ({
      paths: (input.paths ?? []).map((path) => ({ path, status: "missing" })),
      scripts: [],
    })),
    readProvenance: jest.fn(async () => null),
    redactForModel: jest.fn((text: string) => text),
    applyEdit: jest.fn(async (edit: { key: string; text: string }) => {
      texts[edit.key] = edit.text
      return { key: edit.key }
    }),
  } as unknown as Fixture["agentConfig"]
  const notify = jest.fn()
  const navigate = jest.fn(() => true)
  const runEval = jest.fn(async () => ({ runIds: ["e1"], passAt1: 0.75 }))
  const host: GovernanceHost = {
    agentConfig,
    storage: memory(),
    ai: {
      chat: async function* () {
        chatAnswer.calls++
        yield { content: chatAnswer.value }
      },
      getDefaultModel: () => "default-model",
    },
    sessions: {
      listSessions: async () => sessions,
      getMessages: async (sessionId: string) => messages[sessionId] ?? [],
      getSession: jest.fn(async (sessionId: string) =>
        sessionId === "ws-session" ? { projectId: "w" } : {}
      ),
    },
    listWorkspaces: async () => [{ id: "w", name: "Repo", roots: ["/r"] }],
    currentWorkspaceId: () => null,
    resolvePrompt: async (promptId: string, values?: Record<string, string>) =>
      values ? `${promptId}:${values.rule}@${values.location}` : `system:${promptId}`,
    runEval,
    listEvalDatasets: async () => [{ id: "d", name: "Dataset" }],
    config: () => config,
    notify,
    navigate,
    t: (key, params) => (params ? `${key}${JSON.stringify(params)}` : key),
    now: () => clock++,
    newId: () => `id-${++id}`,
    log: jest.fn(),
  }
  return {
    host,
    texts,
    config,
    agentConfig,
    notify,
    navigate,
    runEval,
    chatAnswer,
    messages,
    sessions,
  }
}

const forcePush: RuleCheck = {
  id: "CHK-1",
  kind: "forbid",
  trigger: { family: "shell", command: "^git push --force" },
  scope: "turn",
  summary: "No force push",
  rule: {
    surfaceKey: CLAUDE_KEY,
    surfaceName: "CLAUDE.md",
    startLine: 3,
    endLine: 3,
    text: "Never run `git push --force`.",
  },
}

describe("GovernanceRuntime audit", () => {
  it("audits, stores the run, remembers the workspace and notifies subscribers", async () => {
    const { host } = fixture()
    const runtime = new GovernanceRuntime(host)
    const listener = jest.fn()
    runtime.subscribe(listener)
    const run = await runtime.audit("w")
    expect(run.findings.some((finding) => finding.pattern === "stale-fact")).toBe(true)
    expect((await runtime.latestRun("w"))?.id).toBe(run.id)
    expect(await runtime.store.auditedWorkspaces()).toEqual(["w"])
    expect(await runtime.defaultWorkspace()).toBe("w")
    expect(runtime.getStatus().revision).toBe(1)
    expect(listener).toHaveBeenCalled()
    expect(run.judgeModel).toBe("default-model")
  })

  it("refuses a second operation while one runs, and records failures", async () => {
    const { host, agentConfig } = fixture()
    let release!: () => void
    ;(agentConfig.listSurfaces as jest.Mock).mockImplementationOnce(
      () =>
        new Promise(
          (resolve) => (release = () => resolve({ workspaceId: "w", failed: [], surfaces: [] }))
        )
    )
    const runtime = new GovernanceRuntime(host)
    const first = runtime.audit("w")
    await Promise.resolve()
    await expect(runtime.audit("w")).rejects.toBeInstanceOf(GovernanceBusyError)
    expect(runtime.getStatus().busy?.kind).toBe("audit")
    release()
    await first
    ;(agentConfig.listSurfaces as jest.Mock).mockRejectedValueOnce(new Error("boom"))
    await expect(runtime.audit("w")).rejects.toThrow("boom")
    expect(runtime.getStatus()).toMatchObject({ error: { kind: "audit", message: "boom" } })
  })

  it("merges a partial re-audit into the stored run", async () => {
    const { host, texts } = fixture()
    texts["instruction-file:/r/AGENTS.md"] = "- See `docs/missing.md`."
    const runtime = new GovernanceRuntime(host)
    await runtime.audit("w")
    texts[CLAUDE_KEY] = "# Rules"
    const merged = await runtime.audit("w", [CLAUDE_KEY])
    expect(merged.surfaces.map((entry) => entry.surface.key).sort()).toEqual(
      ["instruction-file:/r/AGENTS.md", CLAUDE_KEY].sort()
    )
    expect(merged.findings.map((finding) => finding.location.surfaceKey)).toEqual([
      "instruction-file:/r/AGENTS.md",
    ])
  })

  it("combines audit and adherence findings", async () => {
    const { host } = fixture()
    const runtime = new GovernanceRuntime(host)
    await runtime.audit("w")
    await runtime.store.saveChecks("w", {
      derivedAt: 1,
      checks: [forcePush],
      notCheckable: 0,
      rejected: 0,
    })
    await runtime.store.saveAdherence("w", {
      ranAt: 1,
      sessions: 1,
      results: [
        {
          checkId: "CHK-1",
          sessionsScanned: 1,
          sessionsTriggered: 1,
          opportunities: 1,
          followed: 0,
          violated: 1,
          excluded: 0,
          samples: [],
        },
      ],
    })
    const findings = await runtime.findings("w")
    expect(findings[0]).toMatchObject({ pattern: "unfollowed-rule", checkId: "CHK-1" })
    expect(findings.length).toBeGreaterThan(1)
  })

  it("applies selected hunks and re-audits what it wrote", async () => {
    const { host, chatAnswer, agentConfig, texts } = fixture()
    chatAnswer.value = JSON.stringify({
      findings: [
        {
          pattern: "fossil",
          startLine: 2,
          evidence: "See `lib/gone.ts`.",
          reason: "Gone.",
          confidence: "high",
          action: "remove",
        },
      ],
    })
    const runtime = new GovernanceRuntime(host)
    const run = await runtime.audit("w")
    const fossil = run.findings.find((finding) => finding.pattern === "fossil")!
    chatAnswer.value = '{"findings":[]}'
    const results = await runtime.apply("w", new Set([fossil.id]))
    expect(results).toEqual([
      expect.objectContaining({ surfaceKey: CLAUDE_KEY, status: "applied" }),
    ])
    expect(agentConfig.applyEdit).toHaveBeenCalledWith(
      expect.objectContaining({ summary: 'apply.summary{"name":"CLAUDE.md","count":1}' })
    )
    expect(texts[CLAUDE_KEY]).toBe("# Rules\n- Never run `git push --force`.")
    expect(
      (await runtime.latestRun("w"))!.findings.some((finding) => finding.id === fossil.id)
    ).toBe(false)
    expect(await runtime.store.appliedChanges()).toHaveLength(1)
    expect(await new GovernanceRuntime(host).apply("none", new Set())).toEqual([])
  })

  it("keeps findings and opens surfaces in the Prompt Center", async () => {
    const { host, navigate } = fixture()
    const runtime = new GovernanceRuntime(host)
    await runtime.setKept("w", "F", true)
    expect(await runtime.store.keptFindings("w")).toEqual(new Set(["F"]))
    runtime.openInPromptCenter(CLAUDE_KEY, "w")
    expect(navigate).toHaveBeenCalledWith(promptCenterHref(CLAUDE_KEY, "w"))
  })

  it("tells when the target model changed since the audit", async () => {
    const { host, config } = fixture()
    const runtime = new GovernanceRuntime(host)
    expect(await runtime.modelChangedSince("w")).toBeUndefined()
    await runtime.audit("w")
    expect(await runtime.modelChangedSince("w")).toBeUndefined()
    config.targetModel = "new-model"
    expect(await runtime.modelChangedSince("w")).toBe("default-model")
  })
})

describe("GovernanceRuntime adherence", () => {
  it("derives checks, replays sessions and labels false matches", async () => {
    const { host, chatAnswer, messages, sessions } = fixture()
    chatAnswer.value = JSON.stringify({
      checks: [
        { rule: "R1", kind: "forbid", trigger: { family: "shell", command: "^git push --force" } },
      ],
    })
    const runtime = new GovernanceRuntime(host)
    expect(await runtime.backtest("w")).toBeUndefined()
    const checks = await runtime.deriveChecks("w")
    expect(checks.checks).toHaveLength(1)
    sessions.push({ id: "s1", projectId: "w", createdAt: 1 })
    messages.s1 = [
      { id: "u", role: "user", parts: [] },
      {
        id: "a",
        role: "assistant",
        parts: [{ type: "tool-bash", input: { command: "git push --force" } }],
      },
    ]
    const adherence = await runtime.backtest("w")
    expect(adherence?.results[0]).toMatchObject({ violated: 1 })
    await runtime.setFalseMatch(checks.checks[0]!.id, "s1", 0, true)
    expect((await runtime.backtest("w"))?.results[0]).toMatchObject({ violated: 0, excluded: 1 })
    await runtime.clearFalseMatches(checks.checks[0]!.id)
    expect((await runtime.backtest("w"))?.results[0]).toMatchObject({ violated: 1, excluded: 0 })
  })

  it("needs a model to derive checks", async () => {
    const { host } = fixture()
    const runtime = new GovernanceRuntime({
      ...host,
      ai: { ...host.ai, getDefaultModel: () => "" },
    })
    await expect(runtime.deriveChecks("w")).rejects.toThrow("errors.noModel")
  })

  it("compares adherence before and after an applied change", async () => {
    const { host, messages, sessions } = fixture()
    const runtime = new GovernanceRuntime(host)
    expect(await runtime.compareSinceChange("missing")).toBeUndefined()
    await runtime.store.recordApplied({
      id: "c",
      at: 100,
      workspaceId: "w",
      surfaceKey: CLAUDE_KEY,
      resultKey: CLAUDE_KEY,
      surfaceName: "CLAUDE.md",
      findingIds: [],
      hunks: 1,
    })
    expect(await runtime.compareSinceChange("c")).toEqual([])
    await runtime.store.saveChecks("w", {
      derivedAt: 1,
      checks: [forcePush],
      notCheckable: 0,
      rejected: 0,
    })
    sessions.push(
      { id: "before", projectId: "w", createdAt: 50 },
      { id: "after", projectId: "w", createdAt: 150 }
    )
    messages.before = [
      {
        id: "a",
        role: "assistant",
        parts: [{ type: "tool-bash", input: { command: "git push --force" } }],
      },
    ]
    messages.after = [
      {
        id: "a",
        role: "assistant",
        parts: [{ type: "tool-bash", input: { command: "git push" } }],
      },
    ]
    expect(await runtime.compareSinceChange("c")).toEqual([
      expect.objectContaining({
        checkId: "CHK-1",
        beforeOpportunities: 1,
        afterOpportunities: 0,
        direction: "insufficient",
      }),
    ])
  })
})

describe("GovernanceRuntime enforcement", () => {
  it("blocks and reminds through adopted rules in the session's workspace", async () => {
    const { host } = fixture()
    const runtime = new GovernanceRuntime(host)
    await runtime.loadEnforcement()
    expect(
      await runtime.preToolUse("bash", { command: "git push --force" }, "ws-session")
    ).toBeUndefined()
    const rule = await runtime.adopt(forcePush, "block", "w")
    expect(await runtime.adopt(forcePush, "block", "w")).toMatchObject({ id: rule.id })
    expect(await runtime.store.rules()).toHaveLength(1)
    expect(await runtime.preToolUse("bash", { command: "git push --force" }, "ws-session")).toBe(
      `${PROMPT_IDS.block}:Never run \`git push --force\`.@CLAUDE.md:3`
    )
    expect(
      await runtime.preToolUse("bash", { command: "git push --force" }, "elsewhere")
    ).toBeUndefined()
    await runtime.updateRule(rule.id, { mode: "remind" })
    expect(
      await runtime.preToolUse("bash", { command: "git push --force" }, "ws-session")
    ).toBeUndefined()
    expect(
      await runtime.postToolUse("bash", { command: "git push --force" }, "pushed", "ws-session")
    ).toBe(`pushed\n\n${PROMPT_IDS.remind}:Never run \`git push --force\`.@CLAUDE.md:3`)
    expect(
      await runtime.postToolUse("bash", { command: "git push --force" }, { ok: true }, "ws-session")
    ).toBeUndefined()
    await runtime.removeRule(rule.id)
    expect(await runtime.store.rules()).toEqual([])
  })

  it("caches the session's workspace and runs nothing while enforcement is off", async () => {
    const { host, config } = fixture()
    const runtime = new GovernanceRuntime(host)
    await runtime.adopt(forcePush, "block", null)
    await runtime.preToolUse("bash", { command: "ls" }, "s")
    await runtime.preToolUse("bash", { command: "ls" }, "s")
    expect(host.sessions.getSession).toHaveBeenCalledTimes(1)
    config.enforcementEnabled = false
    await runtime.loadEnforcement()
    expect(runtime.enforcementEnabled()).toBe(false)
    expect(await runtime.preToolUse("bash", { command: "git push --force" }, "s")).toBeUndefined()
    runtime.onPrompt("s")
    runtime.forgetSessions()
  })
})

describe("GovernanceRuntime verification and drift", () => {
  it("runs evals in the workspace's primary root and records them", async () => {
    const { host, runEval } = fixture()
    const runtime = new GovernanceRuntime(host)
    expect(await runtime.evalDatasets()).toEqual([{ id: "d", name: "Dataset" }])
    const record = await runtime.runEval({
      role: "candidate",
      workspaceId: "w",
      datasetId: "d",
      model: "m",
      changeId: "c",
    })
    expect(runEval).toHaveBeenCalledWith({ datasetId: "d", model: "m", cwd: "/r" })
    expect(record).toMatchObject({
      role: "candidate",
      passAt1: 0.75,
      runIds: ["e1"],
      changeId: "c",
    })
    expect(await runtime.store.evalRecords()).toHaveLength(1)
  })

  it("re-checks audited workspaces without a model and notifies on drift", async () => {
    const { host, texts, notify, chatAnswer } = fixture()
    const runtime = new GovernanceRuntime(host)
    await runtime.audit("w")
    const callsBefore = chatAnswer.calls
    expect(await runtime.driftCheck()).toEqual({ workspaces: 1, changed: 0, newHigh: 0 })
    expect(notify).not.toHaveBeenCalled()
    texts[CLAUDE_KEY] += "\n- Also read `lib/also-gone.ts`."
    expect(await runtime.driftCheck()).toEqual({ workspaces: 1, changed: 1, newHigh: 1 })
    expect(notify).toHaveBeenCalledWith("drift.title", 'drift.body{"changed":1,"findings":1}')
    expect(chatAnswer.calls).toBe(callsBefore)
  })

  it("cancels the running operation", async () => {
    const { host, agentConfig } = fixture()
    const runtime = new GovernanceRuntime(host)
    ;(agentConfig.readSurface as jest.Mock).mockImplementationOnce(async () => {
      runtime.cancel()
      return { key: CLAUDE_KEY, text: "x" }
    })
    await expect(runtime.audit("w")).rejects.toThrow("cancelled")
  })
})

describe("GovernanceRuntime forModel", () => {
  it("redacts tool text and withholds what the host cannot make safe", () => {
    const { host, agentConfig } = fixture()
    const runtime = new GovernanceRuntime(host)
    expect(runtime.forModel("plain")).toBe("plain")
    ;(agentConfig.redactForModel as jest.Mock).mockReturnValueOnce(null)
    expect(runtime.forModel("secret")).toBe(WITHHELD_TEXT)
  })
})

describe("helpers", () => {
  it("builds Prompt Center links only for Prompt Center resources", () => {
    expect(promptCenterHref("skill:a", "w")).toBe(
      "/settings?section=prompts&resource=skill%3Aa&workspace=w"
    )
    expect(promptCenterHref("skill:a", null)).toBe("/settings?section=prompts&resource=skill%3Aa")
    expect(hasPromptCenterEntry("agent-file:/r|x")).toBe(false)
    expect(hasPromptCenterEntry("skill:a")).toBe(true)
  })

  it("recognizes a finding reported before under another id", () => {
    const base: Finding = {
      id: "a",
      group: "brittle-config",
      pattern: "stale-fact",
      location: { surfaceKey: "k" },
      evidence: "See lib/gone.ts now",
      reason: "",
      confidence: "high",
      action: "flag",
      sources: ["judge"],
    }
    expect(knownFinding([base], { ...base, id: "b", evidence: "lib/gone.ts" })).toBe(true)
    expect(knownFinding([base], { ...base, id: "b", evidence: "lib/other.ts" })).toBe(false)
    expect(
      knownFinding([base], { ...base, id: "b", pattern: "conflict", evidence: "lib/gone.ts" })
    ).toBe(false)
  })
})
