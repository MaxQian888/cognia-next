/**
 * Harness Evolution surfaces (ADR-0237), browser build.
 *
 * Runs execute only on the desktop, so this journey seeds a finished run the
 * way the driver stores it (snapshots, run, steps) and checks what a person
 * reviews: the agent's Evolve page behind the feature switch, its blocker in a
 * browser, and the run page with its plan, a step's evidence and diff, and the
 * decision awaiting approval. The seeded rows and the visible run status are
 * the diagnostics when the journey fails.
 */

import { expect, test, type Page } from "@/tests/e2e/fixtures/test"

import { readDexieRow, resetCogniaDb, setCogniaSettings } from "../helpers/db-reset"
import { seedCharacter } from "../helpers/seed-workflow"

const RUN_ID = "e2e-harness-run"

const components = (memory: string) => ({
  systemPrompt: "You turn CSV files into short reports.",
  guardrails: "Never invent numbers.",
  memory,
  toolGuidance: "",
  skills: [],
  subagents: [],
  toolRules: [],
})

const evidence = (snapshotId: string, delivered: boolean) => ({
  snapshotId,
  inputFingerprint: "e2e-task",
  environmentFingerprint: "hef1-e2e",
  output: delivered ? "Wrote report.md. Grand total row: 42." : "North 10, south 32.",
  trajectory: delivered
    ? '[ACTION] Write {"file_path":"report.md"}\n[OBSERVATION] ok'
    : '[ACTION] Read {"file_path":"data.csv"}\n[OBSERVATION] region;amount',
  deliverables: delivered ? [{ path: "report.md", bytes: 24, text: "| total | 42 |" }] : [],
  metrics: {
    inputTokens: 1200,
    outputTokens: 140,
    cacheReadTokens: 0,
    costUsd: 0.02,
    latencyMs: 4000,
    toolCalls: delivered ? 2 : 1,
    toolFailures: 0,
    steps: 3,
  },
  validation: [
    {
      check: "deliverable report.md",
      passed: delivered,
      status: delivered ? "passed" : "failed",
    },
  ],
  blockedActions: [],
  delegations: [],
  degraded: false,
  delivered,
})

/** Put rows straight into the account database that owns the harness tables. */
async function seedHarnessRows(page: Page, characterId: string, characterName: string) {
  const base = {
    schemaVersion: 1,
    id: "e2e-snap-base",
    contentHash: "hsh-base-e2e",
    characterId,
    characterName,
    scope: "task",
    components: components("Reports go in report.md."),
    execution: {},
    runtimeFingerprint: "hrf1-e2e",
    origin: { kind: "captured", runId: RUN_ID },
    createdAt: 1_760_000_000_000,
  }
  const agg = {
    ...base,
    id: "e2e-snap-agg1",
    contentHash: "hsh-agg1-e2e",
    parentId: base.id,
    components: components(
      "Reports go in report.md.\nWrite the report to report.md before answering."
    ),
    origin: { kind: "composed", runId: RUN_ID, label: "agg1" },
    createdAt: 1_760_000_100_000,
  }
  const step = (label: string, kind: string, extra: Record<string, unknown>) => ({
    id: `${RUN_ID}:${label}`,
    runId: RUN_ID,
    label,
    kind,
    status: "succeeded",
    attempts: 1,
    inputTokens: 1200,
    outputTokens: 140,
    modelCalls: kind === "rollout" ? 0 : 1,
    costUsd: 0.02,
    startedAt: 1_760_000_000_000,
    endedAt: 1_760_000_004_000,
    updatedAt: 1_760_000_004_000,
    ...extra,
  })
  const steps = [
    step("base1", "rollout", { snapshotId: base.id, evidence: evidence(base.id, false) }),
    step("inv1", "propose", {
      dim: "INV",
      snapshotId: agg.id,
      notes: "base1 never wrote report.md.",
    }),
    step("dom1", "propose", { dim: "DOM", snapshotId: base.id, keptBase: true }),
    step("roll:inv1", "rollout", { snapshotId: agg.id, evidence: evidence(agg.id, true) }),
    step("roll:dom1", "rollout", {
      snapshotId: base.id,
      evidence: evidence(base.id, false),
      cacheHitOf: `${RUN_ID}:base1`,
    }),
    step("agg1", "compose", {
      dim: "AGG",
      snapshotId: agg.id,
      notes: "Kept the rule that made the rollout write its file.",
    }),
    step("roll:agg1", "rollout", { snapshotId: agg.id, evidence: evidence(agg.id, true) }),
    step("select", "select", {
      selection: { method: "deterministic", regressed: [], dominant: ["agg1"], unchanged: [] },
    }),
  ]
  const run = {
    id: RUN_ID,
    characterId,
    characterName,
    trigger: "manual",
    task: {
      title: "E2E CSV report",
      prompt: "Summarise data.csv into report.md.",
      domain: "office/reports",
      isolation: "files",
      expectedDeliverables: ["report.md"],
      checks: [{ kind: "deliverable-file", path: "report.md" }],
      source: { kind: "custom" },
      inputHash: "e2e-task",
    },
    config: {
      mode: "parallel",
      k: 1,
      scope: "task",
      editable: ["systemPrompt", "guardrails", "memory", "toolGuidance", "skills"],
      models: {},
      budget: {
        maxIterations: 2,
        maxCandidates: 4,
        maxParallelRuns: 2,
        maxModelCalls: 40,
        maxTokens: 4_000_000,
        maxCostUsd: 5,
        maxWallTimeMs: 7_200_000,
        maxTurnsPerRollout: 40,
      },
      autoAdoptLowRisk: false,
      useExperiences: true,
      editorChannel: "structured",
      probe: { allowedMcpServerIds: [], networkOff: true },
      seed: 7,
    },
    status: "awaiting_approval",
    round: 0,
    baseSnapshotId: base.id,
    finalLabels: ["agg1"],
    decision: {
      outcome: "adopt",
      reason: "agg1 delivered report.md where every base rollout did not.",
      chosenLabel: "agg1",
      chosenSnapshotId: agg.id,
      risk: "low",
      riskReasons: ["memory.md: one line added"],
      requiresApproval: true,
    },
    experienceIds: [],
    ledger: {
      costUsd: 0.12,
      costUnknown: false,
      inputTokens: 7200,
      outputTokens: 840,
      modelCalls: 3,
      rollouts: 3,
      sessions: 3,
      maxObservedCostUsd: { rollout: 0.02, propose: 0.02, compose: 0.02 },
    },
    dedupeKey: "hrd1-e2e",
    version: 5,
    createdAt: 1_760_000_000_000,
    updatedAt: 1_760_000_010_000,
    startedAt: 1_760_000_000_000,
  }

  await page.evaluate(
    async (rows) => {
      const names = (await indexedDB.databases())
        .map((info) => info.name)
        .filter((name): name is string => Boolean(name))
      for (const name of names) {
        const done = await new Promise<boolean>((resolve, reject) => {
          const req = indexedDB.open(name)
          req.onerror = () => reject(req.error)
          req.onsuccess = () => {
            const conn = req.result
            conn.onversionchange = () => conn.close()
            const tables = ["harnessSnapshots", "harnessEvolutionRuns", "harnessEvolutionSteps"]
            if (!tables.every((t) => conn.objectStoreNames.contains(t))) {
              conn.close()
              resolve(false)
              return
            }
            const tx = conn.transaction(tables, "readwrite")
            for (const s of rows.snapshots) tx.objectStore("harnessSnapshots").put(s)
            tx.objectStore("harnessEvolutionRuns").put(rows.run)
            for (const s of rows.steps) tx.objectStore("harnessEvolutionSteps").put(s)
            tx.oncomplete = () => {
              conn.close()
              resolve(true)
            }
            tx.onerror = () => {
              conn.close()
              reject(tx.error)
            }
          }
        })
        if (done) return
      }
      throw new Error("No database owns the Harness Evolution tables")
    },
    { snapshots: [base, agg], run, steps }
  )
}

test.describe("harness evolution", () => {
  test("shows the Evolve page behind the switch and a stored run for review", async ({ page }) => {
    await page.goto("/agents")
    await resetCogniaDb(page)
    const agentId = await seedCharacter(page, {
      name: "E2E Analyst",
      systemPrompt: "You turn CSV files into short reports.",
    })

    // Off by default: no Evolve entry on the agent.
    await page.goto(`/agents?id=${agentId}`, { waitUntil: "domcontentloaded" })
    await expect(page.getByTestId("agent-detail")).toBeVisible()
    await expect(page.getByTestId("agent-evolve")).toHaveCount(0)

    await setCogniaSettings(page, { harnessEvolution: { enabled: true, startMode: "manual" } })
    await seedHarnessRows(page, agentId, "E2E Analyst")
    await expect
      .poll(
        async () =>
          (
            await readDexieRow<{ status: string }>(page, {
              table: "harnessEvolutionRuns",
              key: RUN_ID,
            })
          )?.status
      )
      .toBe("awaiting_approval")

    await page.goto(`/agents?id=${agentId}`, { waitUntil: "domcontentloaded" })
    await page.getByTestId("agent-evolve").click()
    await expect(page.getByTestId("agent-detail")).toHaveAttribute("data-mode", "evolve")
    await expect(page.getByTestId("agent-evolution-view")).toBeVisible()
    // A browser build has no agent runtime: starting is blocked and says why.
    await expect(page.getByTestId("harness-blocker")).toHaveAttribute("data-blocker", "no-runtime")
    await expect(page.getByTestId("harness-start-run")).toBeDisabled()

    await page.goto(`/agents/evolution?run=${RUN_ID}`, { waitUntil: "domcontentloaded" })
    const viewer = page.getByTestId("harness-run-viewer")
    await expect(viewer).toHaveAttribute("data-status", "awaiting_approval")
    await expect(page.getByRole("heading", { name: "E2E CSV report" })).toBeVisible()
    // Awaiting approval opens on the decision.
    await expect(page.getByTestId("harness-decision")).toContainText("Adopt")
    await expect(page.getByTestId("harness-decision-risk")).toHaveText("Low risk")
    await expect(page.getByTestId("harness-approve")).toBeVisible()

    await page.getByRole("tab", { name: "Steps" }).click()
    await page.getByTestId("harness-step-agg1").click()
    const detail = page.getByTestId("harness-step-detail")
    await expect(detail).toContainText("Kept the rule that made the rollout write its file.")
    await expect(detail.getByTestId("harness-diff")).toContainText("memory.md")

    await page.getByTestId("harness-step-roll:dom1").click()
    await expect(page.getByTestId("harness-step-detail")).toContainText("Not delivered")
  })
})
