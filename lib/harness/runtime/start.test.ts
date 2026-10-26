import type { AppSettings, Character } from "@cognia/agent-config-types"
import type { HarnessEvolutionRun } from "@/types/harness/evolution"
import type { HarnessSnapshotV1 } from "@/types/harness/snapshot"
import { DEFAULT_HARNESS_BUDGET } from "../budget"
import { makeComponents } from "../test-fixtures"
import {
  HarnessStartError,
  buildRunConfig,
  freezeTask,
  normalizeDomain,
  preflightModels,
  previewHarnessRun,
  startHarnessRun,
  validateTaskDraft,
  type HarnessTaskDraft,
  type StartDeps,
} from "./start"

const agent: Character = {
  id: "agent-1",
  name: "Analyst",
  avatarColor: "x",
  systemPrompt: "p",
  model: "claude-x",
  providerId: "anthropic",
  createdAt: 1,
  updatedAt: 1,
}

const base = {
  id: "snap-base",
  contentHash: "hash-base",
  runtimeFingerprint: "hrf1-a",
  components: makeComponents(),
} as HarnessSnapshotV1

const draft: HarnessTaskDraft = {
  title: " CSV report ",
  prompt: "Summarise data.csv into report.md.",
  domain: "Office / Reports",
  isolation: "files",
  inputFiles: [{ sourcePath: "/host/data.csv", relativePath: "data.csv" }],
  expectedDeliverables: ["report.md"],
  checks: [{ kind: "deliverable-file", path: "report.md" }],
  source: { kind: "custom" },
}

const enabled = {
  harnessEvolution: { enabled: true, startMode: "failure-triggered", defaultK: 2 },
} as unknown as AppSettings

function deps(over: Partial<StartDeps> = {}): StartDeps & { created: HarnessEvolutionRun[] } {
  const created: HarnessEvolutionRun[] = []
  return {
    created,
    getSettings: async () => enabled,
    capture: async () => ({
      snapshot: base,
      character: agent,
      skills: [],
      carriedSkillIds: [],
      enabledMcpServerIds: [],
      reused: true,
    }),
    hashFile: async () => "a".repeat(64),
    headCommit: async () => "b".repeat(40),
    canCallModel: async () => true,
    createRun: async (run) => {
      const open = created.find((r) => r.dedupeKey === run.dedupeKey)
      if (open) return { created: false, run: open }
      created.push(run)
      return { created: true, run }
    },
    now: () => 10,
    newId: () => `run-${created.length + 1}`,
    seed: () => 42,
    ...over,
  }
}

describe("task drafts", () => {
  it("normalises domains", () => {
    expect(normalizeDomain("Office / Reports")).toBe("office/reports")
    expect(normalizeDomain(" ")).toBe("general")
    expect(normalizeDomain("前端 / React 组件")).toBe("前端/react-组件")
  })

  it("explains what makes a task unrunnable", () => {
    expect(validateTaskDraft(draft)).toEqual([])
    const errors = validateTaskDraft({
      ...draft,
      title: "",
      isolation: "none",
      inputFiles: [{ sourcePath: "/x", relativePath: "../escape" }],
      checks: [
        { kind: "deliverable-file", path: "report.md" },
        { kind: "acceptance-profile", profileId: "p" },
        { kind: "output-contains", value: "" },
      ],
    })
    expect(errors.join(" ")).toMatch(/title/)
    expect(errors.join(" ")).toMatch(/scratch-directory/)
    expect(errors.join(" ")).toMatch(/must be relative/)
    expect(errors.join(" ")).toMatch(/cannot check for files/)
    expect(errors.join(" ")).toMatch(/Acceptance profiles/)
    expect(errors.join(" ")).toMatch(/text to look for/)
    expect(validateTaskDraft({ ...draft, isolation: "git", inputFiles: [] })).toEqual([
      "A git task needs the repository it starts from.",
    ])
  })

  it("freezes file hashes, the base commit and the task hash", async () => {
    const task = await freezeTask(draft, deps())
    expect(task).toMatchObject({
      title: "CSV report",
      domain: "office/reports",
      inputFiles: [{ relativePath: "data.csv", sha256: "a".repeat(64) }],
    })
    expect(task.inputHash).toMatch(/^[0-9a-f]{64}$/)
    const gitTask = await freezeTask(
      { ...draft, isolation: "git", inputFiles: [], git: { sourceRoot: "/repo" } },
      deps()
    )
    expect(gitTask.git).toEqual({
      sourceRoot: "/repo",
      baseRef: "HEAD",
      resolvedBaseSha: "b".repeat(40),
    })
    const pinned = await freezeTask(
      {
        ...draft,
        isolation: "git",
        inputFiles: [],
        git: { sourceRoot: "/repo", baseRef: "C".repeat(40) },
      },
      deps()
    )
    expect(pinned.git?.resolvedBaseSha).toBe("c".repeat(40))
    await expect(
      freezeTask(
        { ...draft, isolation: "git", inputFiles: [], git: { sourceRoot: "/r", baseRef: "main" } },
        deps()
      )
    ).rejects.toMatchObject({ code: "invalid-task" })
    await expect(
      freezeTask(
        { ...draft, isolation: "git", inputFiles: [], git: { sourceRoot: "/r" } },
        deps({ headCommit: async () => undefined })
      )
    ).rejects.toMatchObject({ code: "no-commit" })
  })
})

describe("buildRunConfig", () => {
  it("takes the settings' defaults and the dialog's overrides, clamped", () => {
    const config = buildRunConfig(
      enabled,
      { budget: { maxCostUsd: 10_000 }, editable: ["memory", "skills"] },
      3
    )
    expect(config).toMatchObject({
      mode: "parallel",
      k: 2,
      scope: "task",
      editable: ["memory", "skills"],
      seed: 3,
      probe: { networkOff: true, allowedMcpServerIds: [] },
    })
    expect(config.budget.maxCostUsd).toBe(500)
    expect(buildRunConfig(null, { k: 4 }, 1).k).toBe(2)
  })
})

describe("preflightModels", () => {
  it("names the roles no model can serve", async () => {
    const config = buildRunConfig(enabled, { editorChannel: "structured" }, 1)
    await expect(
      preflightModels(config, agent, { canCallModel: async (m) => m.model !== "claude-x" })
    ).rejects.toThrow(/editor, composer, selector, reflector/)
    const agentic = buildRunConfig(enabled, { editorChannel: "agentic" }, 1)
    const asked: string[] = []
    await preflightModels(agentic, agent, {
      canCallModel: async (m) => {
        asked.push(m.model ?? "")
        return true
      },
    })
    expect(asked).toHaveLength(2)
  })
})

describe("startHarnessRun", () => {
  it("stores a queued run on the captured base and collapses a repeat onto it", async () => {
    const d = deps()
    const first = await startHarnessRun(
      { characterId: "agent-1", trigger: "manual", task: draft },
      d
    )
    expect(first.created).toBe(true)
    expect(first.run).toMatchObject({
      status: "queued",
      baseSnapshotId: "snap-base",
      characterName: "Analyst",
      finalLabels: ["agg1", "agg2"],
      version: 1,
    })
    expect(first.run.dedupeKey).toMatch(/^hrd1-/)
    const again = await startHarnessRun(
      { characterId: "agent-1", trigger: "manual", task: draft },
      d
    )
    expect(again).toEqual({ created: false, run: first.run })
  })

  it("refuses when the feature is off, the trigger not allowed or the scope incomplete", async () => {
    await expect(
      startHarnessRun(
        { characterId: "a", trigger: "manual", task: draft },
        deps({ getSettings: async () => null })
      )
    ).rejects.toMatchObject({ code: "disabled" })
    await expect(
      startHarnessRun({ characterId: "a", trigger: "background", task: draft }, deps())
    ).rejects.toMatchObject({ code: "trigger-not-allowed" })
    await expect(
      startHarnessRun(
        { characterId: "a", trigger: "manual", task: draft, overrides: { scope: "session" } },
        deps()
      )
    ).rejects.toBeInstanceOf(HarnessStartError)
    await expect(
      startHarnessRun(
        { characterId: "a", trigger: "manual", task: draft, overrides: { scope: "workspace" } },
        deps()
      )
    ).rejects.toMatchObject({ code: "no-workspace" })
  })
})

describe("previewHarnessRun", () => {
  it("prices the scheduled work from comparable runs and flags crossed ceilings", async () => {
    const preview = await previewHarnessRun(
      { mode: "parallel", k: 2, budget: { ...DEFAULT_HARNESS_BUDGET, maxCostUsd: 1 }, models: {} },
      agent,
      {
        estimateSingleRun: async (query) => {
          expect(query).toEqual({ model: "claude-x", providerId: "anthropic" })
          return {
            confidence: "few",
            sampleCount: 7,
            costUsd: { p50: 0.05, p90: 0.1 },
            tokens: { p50: 10_000, p90: 20_000 },
            durationMs: { p50: 60_000, p90: 120_000 },
          }
        },
      }
    )
    expect(preview.estimate.work).toMatchObject({ rollouts: 8, editorSessions: 6 })
    // 8 × 0.10 + (6 + 2) × 0.05
    expect(preview.estimate.costUsd).toBeCloseTo(1.2)
    expect(preview.estimate.exceeds).toContain("maxCostUsd")
    expect(preview).toMatchObject({ confidence: "few", sampleCount: 7 })
  })
})
