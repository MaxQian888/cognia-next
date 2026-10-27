/** @jest-environment node */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  loadPinnedFile,
  readBenchmarkCredential,
  serializeBenchmarkArtifact,
  runBenchmark,
  replayBenchmarkJournal,
  summarizeBenchmarkJournal,
  selectDiagnosticTaskIds,
  type BenchmarkOptions,
} from "./multiagentbench-runner"
import {
  MULTIAGENTBENCH_SOURCE,
  MULTIAGENTBENCH_PROFILE,
  MULTIAGENTBENCH_EVALUATION_PROTOCOL,
  researchStructure,
} from "@/lib/ai/eval/multiagentbench"
import {
  runResearchTrial,
  type ResearchTrialInput,
  type ResearchTrial,
} from "@/lib/ai/eval/multiagentbench-runtime"
import fixture from "@/test-fixtures/eval/multiagentbench/research-1.json"
import rubrics from "@/test-fixtures/eval/multiagentbench/evaluator-prompts.json"
import { runIsolatedTeamEval } from "@/lib/ai/eval/team-execution"
import { BenchmarkStorage } from "./multiagentbench-storage"

function fixtureOptions(runDir: string): BenchmarkOptions {
  return {
    dryRun: false,
    offline: true,
    cases: 1,
    repetitions: 1,
    seed: 20261025,
    timeoutMs: 1000,
    judgeTimeoutMs: 1000,
    tokenBudget: 100000,
    judgeTokenBudget: 100000,
    model: "fixture",
    judgeModel: "fixture",
    reasoningEffort: "low",
    maxSolverOutputTokens: 100,
    maxJudgeOutputTokens: 100,
    baseURL: "http://127.0.0.1:8787/v1",
    runDir,
    diagnostics: "primary",
    diagnosticEvery: 10,
  }
}
const fixtureSource = async (pin: { path: string }) =>
  pin.path === MULTIAGENTBENCH_SOURCE.research.path
    ? Array.from({ length: 100 }, (_, i) => JSON.stringify({ ...fixture, task_id: i + 1 })).join(
        "\n"
      )
    : pin.path === MULTIAGENTBENCH_SOURCE.rubrics.path
      ? JSON.stringify(rubrics)
      : "MIT License"
const diskPolicy = { minFreeBytes: 0, reserveBytes: 4096, pollMs: 1 }
function callSample() {
  return {
    output: "proposal",
    toolCalls: [],
    retrievedChunks: [],
    costUsd: 0,
    latencyMs: 1,
    stepCount: 1,
    degraded: false,
    usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 },
    metricAvailability: { usage: "known", cost: "unavailable", latency: "known" },
  }
}

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "cognia-marble-test-"))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

it("fetches the exact revision, verifies the official license hash and reuses it offline", async () => {
  const bytes = await fs.readFile(path.resolve("test-fixtures/eval/multiagentbench/LICENSE"))
  const request = jest.fn(
    async (_url: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
      new Response(bytes)
  )
  const options = { sourceDir: dir, offline: false }
  const license = await loadPinnedFile(MULTIAGENTBENCH_SOURCE.license, options, request)
  expect(license).toContain("MIT License")
  expect(request.mock.calls[0][0]).toContain(MULTIAGENTBENCH_SOURCE.revision)
  const offline = jest.fn(async () => {
    throw Error("Network must not be used")
  })
  expect(
    await loadPinnedFile(MULTIAGENTBENCH_SOURCE.license, { ...options, offline: true }, offline)
  ).toBe(license)
  expect(offline).not.toHaveBeenCalled()
})

it("binds automatic credential lookup to the authorized loopback proxy", async () => {
  const readLocal = jest.fn(async () => "private-sentinel-key")
  await expect(
    readBenchmarkCredential("https://other.example/v1", undefined, readLocal)
  ).rejects.toThrow(/explicit/)
  expect(readLocal).not.toHaveBeenCalled()
  expect(await readBenchmarkCredential("http://127.0.0.1:8787/v1", undefined, readLocal)).toBe(
    "private-sentinel-key"
  )
  expect(await readBenchmarkCredential("https://other.example/v1", "explicit-key", readLocal)).toBe(
    "explicit-key"
  )
  expect(readLocal).toHaveBeenCalledTimes(1)
})

it("filters credentials in nested provider errors, outputs and console payloads", () => {
  const secret = 'sentinel-key-"with-quotes'
  const json = serializeBenchmarkArtifact(
    { error: `Remote error ${secret}`, nested: [{ output: secret }] },
    secret
  )
  expect(json).not.toContain("sentinel-key")
  expect(JSON.parse(json)).toEqual({
    error: "Remote error [REDACTED_API_KEY]",
    nested: [{ output: "[REDACTED_API_KEY]" }],
  })
})

it("refuses corrupt cache and downloaded bytes without silently replacing them", async () => {
  const request = jest.fn(async () => new Response("corrupt"))
  await expect(
    loadPinnedFile(MULTIAGENTBENCH_SOURCE.license, { sourceDir: dir, offline: false }, request)
  ).rejects.toThrow(/checksum/)
  await fs.writeFile(path.join(dir, "LICENSE"), "corrupt cache")
  request.mockClear()
  await expect(
    loadPinnedFile(MULTIAGENTBENCH_SOURCE.license, { sourceDir: dir, offline: false }, request)
  ).rejects.toThrow(/checksum/)
  expect(request).not.toHaveBeenCalled()
  expect(await fs.readFile(path.join(dir, "LICENSE"), "utf8")).toBe("corrupt cache")
})

it("does not request missing sources in offline mode", async () => {
  const request = jest.fn(async () => new Response("unused"))
  await expect(
    loadPinnedFile(MULTIAGENTBENCH_SOURCE.license, { sourceDir: dir, offline: true }, request)
  ).rejects.toThrow(/not cached/)
  expect(request).not.toHaveBeenCalled()
})

it("preserves an interrupted call liability, skips durable cells and requires explicit retry", async () => {
  const options: BenchmarkOptions = {
    dryRun: false,
    offline: true,
    cases: 1,
    repetitions: 1,
    seed: 20261025,
    timeoutMs: 1000,
    judgeTimeoutMs: 1000,
    tokenBudget: 100000,
    judgeTokenBudget: 100000,
    model: "fixture",
    judgeModel: "fixture",
    reasoningEffort: "low",
    maxSolverOutputTokens: 100,
    maxJudgeOutputTokens: 100,
    baseURL: "http://127.0.0.1:8787/v1",
    runDir: dir,
    diagnostics: "primary",
    diagnosticEvery: 10,
  }
  const readCredential = jest.fn(async () => "private-fixture-credential")
  const loadSource = jest.fn(async (pin: { path: string }) =>
    pin.path === MULTIAGENTBENCH_SOURCE.research.path
      ? Array.from({ length: 100 }, (_, i) => JSON.stringify({ ...fixture, task_id: i + 1 })).join(
          "\n"
        )
      : pin.path === MULTIAGENTBENCH_SOURCE.rubrics.path
        ? JSON.stringify(rubrics)
        : "MIT License"
  )
  let invocations = 0
  const runTrial = jest.fn(async (input: ResearchTrialInput): Promise<ResearchTrial> => {
    const callId = `fixture-call-${++invocations}`
    await input.onCall?.({
      state: "admitted",
      callId,
      phase: "solver",
      agentId: "single-agent",
      taskId: "final-proposal",
    })
    if (invocations === 2) throw Error("crash after admission")
    const sample = {
      ...callSample(),
      usage: { ...callSample().usage, cacheReadTokens: 1 },
    } as const
    await input.onCall?.({
      state: "settled",
      callId,
      phase: "solver",
      agentId: "single-agent",
      taskId: "final-proposal",
      sample: sample as ResearchTrial["solver"]["sample"],
    })
    return {
      profile: MULTIAGENTBENCH_PROFILE,
      evaluationProtocol: MULTIAGENTBENCH_EVALUATION_PROTOCOL,
      acceptance: researchStructure("proposal"),
      contributionContract: [],
      taskId: input.task.taskId,
      variant: input.variant,
      repetition: input.repetition,
      solver: {
        status: "completed",
        output: "proposal",
        wallTimeMs: 10,
        contributions: [],
        sample: sample as ResearchTrial["solver"]["sample"],
      },
      judgments: [
        {
          kind: "research",
          status: "graded",
          attempted: true,
          ratings: { innovation: 3, safety: 4, feasibility: 2 },
          visibleProposal: "proposal",
          evidence: Object.fromEntries(
            ["innovation", "safety", "feasibility"].map((k) => [
              k,
              { reason: "Fixture reason", quote: "proposal" },
            ])
          ) as never,
          sample: {
            ...sample,
            output: JSON.stringify({
              ratings: { innovation: 3, safety: 4, feasibility: 2 },
              evidence: Object.fromEntries(
                ["innovation", "safety", "feasibility"].map((k) => [
                  k,
                  { reason: "Fixture reason", quote: "proposal" },
                ])
              ),
            }),
          } as never,
        },
        { kind: "communication", status: "not_applicable", attempted: false },
        { kind: "milestones", status: "skipped", attempted: false },
      ],
    }
  })
  const deps = {
    readCredential,
    loadSource,
    runTrial,
    diskPolicy: { minFreeBytes: 0, reserveBytes: 4096, pollMs: 1 },
  }
  const consoleLog = jest.spyOn(console, "log").mockImplementation(() => {})
  try {
    await expect(runBenchmark(options, {}, deps)).rejects.toThrow("crash after admission")
    const first = JSON.parse(await fs.readFile(path.join(dir, "results.json"), "utf8"))
    expect(first.finishedTrials).toBe(1)
    expect(first.allAttemptedTrials).toBe(2)
    const manifest = JSON.parse(await fs.readFile(path.join(dir, "manifest.json"), "utf8"))
    readCredential.mockClear()
    await expect(
      runBenchmark(options, {}, deps, { manifest, retryInterrupted: false })
    ).rejects.toThrow(/--retry-interrupted/)
    expect(readCredential).not.toHaveBeenCalled()
    expect(invocations).toBe(2)
    expect(await runBenchmark(options, {}, deps, { manifest, retryInterrupted: true })).toBe(0)
    const final = JSON.parse(await fs.readFile(path.join(dir, "results.json"), "utf8"))
    expect(final.finishedTrials).toBe(3)
    expect(final.allAttemptedTrials).toBe(4)
    expect(final.trials[0]).toEqual(first.trials[0])
    expect(
      final.summary.reduce(
        (sum: number, row: { solverTokens: { total: number } }) => sum + row.solverTokens.total,
        0
      )
    ).toBe(36)
    expect(
      final.summary.reduce(
        (sum: number, row: { solverTokens: { unknownLiabilityCalls: number } }) =>
          sum + row.solverTokens.unknownLiabilityCalls,
        0
      )
    ).toBe(1)
    expect(
      final.summary.some(
        (row: { solverTokens: { totalsAreLowerBounds: boolean } }) =>
          row.solverTokens.totalsAreLowerBounds
      )
    ).toBe(true)
    // The journal owns replay, even if the projection is stale.
    await fs.writeFile(
      path.join(dir, "results.json"),
      JSON.stringify({ trials: [], recoveryEvents: [] })
    )
    readCredential.mockClear()
    expect(await runBenchmark(options, {}, deps, { manifest, retryInterrupted: false })).toBe(0)
    expect(readCredential).not.toHaveBeenCalled()
    expect(invocations).toBe(4)
    const replayed = JSON.parse(await fs.readFile(path.join(dir, "results.json"), "utf8"))
    expect(replayed.trials).toEqual(final.trials)
    // A salvaged response must survive another disk failure while importing it.
    const journalFile = path.join(dir, "events.ndjson")
    const records = (await fs.readFile(journalFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    const lastStarted = records.findLastIndex((row) => row.kind === "attempt-started")
    const lastAdmission = records.findIndex(
      (row, index) => index > lastStarted && row.kind === "call" && row.call.state === "admitted"
    )
    const salvage = records.slice(lastAdmission + 1)
    const prefix = records.slice(0, lastAdmission + 1)
    await fs.writeFile(journalFile, prefix.map((row) => JSON.stringify(row)).join("\n") + "\n")
    await fs.writeFile(path.join(dir, "results.json"), JSON.stringify({ recoveryEvents: salvage }))
    const appendFault = jest
      .spyOn(BenchmarkStorage.prototype, "append")
      .mockRejectedValueOnce(Error("second recovery disk failure"))
    await expect(
      runBenchmark(options, {}, deps, { manifest, retryInterrupted: false })
    ).rejects.toThrow("second recovery disk failure")
    appendFault.mockRestore()
    const afterFailure = JSON.parse(await fs.readFile(path.join(dir, "results.json"), "utf8"))
    expect(afterFailure.recoveryEvents).toEqual(salvage)
    expect(
      afterFailure.summary.reduce(
        (sum: number, row: { solverTokens: { total: number } }) => sum + row.solverTokens.total,
        0
      )
    ).toBe(36)
    expect(await runBenchmark(options, {}, deps, { manifest, retryInterrupted: false })).toBe(0)
    expect(readCredential).not.toHaveBeenCalled()
    expect(invocations).toBe(4)
    const recovered = JSON.parse(await fs.readFile(path.join(dir, "results.json"), "utf8"))
    expect(recovered.recoveryEvents).toEqual([])
    expect(recovered.trials).toEqual(final.trials)
    const beforeDuplicateFreshRun = await fs.readFile(path.join(dir, "results.json"), "utf8")
    await expect(runBenchmark(options, {}, deps)).rejects.toThrow(/EEXIST/)
    expect(await fs.readFile(path.join(dir, "results.json"), "utf8")).toBe(beforeDuplicateFreshRun)
    const knownJournal = await fs.readFile(journalFile, "utf8")
    await fs.appendFile(journalFile, "corrupt interior record\n")
    await expect(
      runBenchmark(options, {}, deps, { manifest, retryInterrupted: false })
    ).rejects.toThrow()
    expect(await fs.readFile(path.join(dir, "results.json"), "utf8")).toBe(beforeDuplicateFreshRun)
    await fs.writeFile(
      journalFile,
      knownJournal +
        JSON.stringify({
          kind: "attempt-started",
          attemptId: "unscheduled",
          entry: { caseId: "999", variant: "single-agent", repetition: 1 },
          at: new Date().toISOString(),
        }) +
        "\n"
    )
    await expect(
      runBenchmark(options, {}, deps, { manifest, retryInterrupted: false })
    ).rejects.toThrow(/unscheduled/)
    expect(await fs.readFile(path.join(dir, "results.json"), "utf8")).toBe(beforeDuplicateFreshRun)
    const files = await fs.readdir(dir)
    expect(files).not.toContain(".runner-lock")
    expect(files).not.toContain(".emergency-reserve")
    for (const name of files) {
      if ((await fs.stat(path.join(dir, name))).isFile())
        expect(await fs.readFile(path.join(dir, name), "utf8")).not.toContain(
          "private-fixture-credential"
        )
    }
  } finally {
    consoleLog.mockRestore()
  }
})

it("rejects orphan/duplicate settlements and never counts cache reads twice", () => {
  expect(() =>
    replayBenchmarkJournal([{ kind: "attempt-settled", attemptId: "missing", trial: {} }])
  ).toThrow(/active attempt/)
  expect(
    summarizeBenchmarkJournal([]).every(
      (row) => row.solverTokens.total === 0 && !row.solverTokens.totalsAreLowerBounds
    )
  ).toBe(true)
})

it("samples diagnostics deterministically across roster strata and pairs all variants", () => {
  const tasks = Array.from({ length: 30 }, (_, i) => ({
    taskId: String(i),
    content: "introduction",
    outputFormat: "5q",
    agents: Array.from({ length: i < 10 ? 2 : i < 20 ? 5 : 8 }, (_, j) => ({
      agentId: String(j),
      profile: "profile",
    })),
  }))
  const selected = selectDiagnosticTaskIds(tasks, 10, 123)
  expect(selected).toHaveLength(3)
  expect(selected).toEqual(selectDiagnosticTaskIds(tasks, 10, 123))
  expect(new Set(selected.map((id) => Math.floor(Number(id) / 10))).size).toBe(3)
})

it.each(["missing-trial", "missing-usage", "negative-usage", "mismatched-phase"])(
  "refuses %s recovery before changing evidence or reading credentials",
  async (mode) => {
    const options = fixtureOptions(dir)
    const log = jest.spyOn(console, "log").mockImplementation(() => {})
    const readCredential = jest.fn(async () => "unused-fixture")
    const runTrial = jest.fn(async () => {
      throw Error("must not dispatch")
    })
    const deps = { loadSource: fixtureSource, diskPolicy, readCredential, runTrial }
    try {
      await runBenchmark({ ...options, dryRun: true }, {}, deps)
      const seed = JSON.parse(await fs.readFile(path.join(dir, "manifest.json"), "utf8"))
      const manifest = {
        ...seed,
        mode: "live",
        executionOptions: { ...seed.executionOptions, dryRun: false },
      }
      const entry = manifest.schedule[0]
      const event = (kind: string, fields: object) => ({
        kind,
        attemptId: "a",
        at: new Date().toISOString(),
        ...fields,
      })
      const call = {
        phase: "solver",
        callId: "c",
        agentId: "single-agent",
        taskId: "final-proposal",
      }
      const started = event("attempt-started", { entry })
      const admitted = event("call", { call: { ...call, state: "admitted" } })
      const sample = callSample()
      const badSample: Record<string, unknown> = { ...sample }
      if (mode === "missing-usage") delete badSample.usage
      if (mode === "negative-usage") badSample.usage = { ...sample.usage, inputTokens: -900 }
      const recovery =
        mode === "missing-trial"
          ? event("attempt-settled", {
              trial: { taskId: entry.caseId, variant: entry.variant, repetition: entry.repetition },
            })
          : event("call", {
              call: {
                ...call,
                state: "settled",
                sample: badSample,
                ...(mode === "mismatched-phase"
                  ? {
                      phase: "judge",
                      agentId: undefined,
                      taskId: undefined,
                      judgmentKind: "research",
                    }
                  : {}),
              },
            })
      const originalJournal =
        JSON.stringify(started) +
        "\n" +
        (mode === "missing-trial" ? "" : JSON.stringify(admitted) + "\n")
      const originalSnapshot = JSON.stringify({ marker: "preserve", recoveryEvents: [recovery] })
      await fs.writeFile(path.join(dir, "events.ndjson"), originalJournal)
      await fs.writeFile(path.join(dir, "results.json"), originalSnapshot)
      await expect(
        runBenchmark(options, {}, deps, { manifest, retryInterrupted: true })
      ).rejects.toThrow()
      expect(await fs.readFile(path.join(dir, "events.ndjson"), "utf8")).toBe(originalJournal)
      expect(await fs.readFile(path.join(dir, "results.json"), "utf8")).toBe(originalSnapshot)
      expect(readCredential).not.toHaveBeenCalled()
      expect(runTrial).not.toHaveBeenCalled()
    } finally {
      log.mockRestore()
    }
  }
)

it.each([
  { model: "other-model" },
  { timeoutMs: "not-a-number" },
  { timeoutMs: 0 },
  { dryRun: true },
  { tokenBudget: -1 },
  { maxJudgeOutputTokens: 20000 },
])("rejects inconsistent or invalid frozen options before opening evidence: %p", async (patch) => {
  const options = fixtureOptions(dir)
  const log = jest.spyOn(console, "log").mockImplementation(() => {})
  const readCredential = jest.fn(async () => "unused")
  const deps = { loadSource: fixtureSource, diskPolicy, readCredential }
  try {
    await runBenchmark({ ...options, dryRun: true }, {}, deps)
    const seed = JSON.parse(await fs.readFile(path.join(dir, "manifest.json"), "utf8"))
    const manifest = {
      ...seed,
      mode: "live",
      executionOptions: { ...seed.executionOptions, dryRun: false, ...patch },
    }
    const original = "prior-snapshot"
    await fs.writeFile(path.join(dir, "results.json"), original)
    await expect(
      runBenchmark(manifest.executionOptions, {}, deps, { manifest, retryInterrupted: false })
    ).rejects.toThrow()
    expect(await fs.readFile(path.join(dir, "results.json"), "utf8")).toBe(original)
    expect(readCredential).not.toHaveBeenCalled()
    expect(
      (await fs.readdir(dir)).some(
        (name) => name.includes("lock") || name.startsWith("snapshot-before-resume")
      )
    ).toBe(false)
  } finally {
    log.mockRestore()
  }
})

it("keeps durable admission liabilities when cancellation occurs before dispatch", async () => {
  const readCredential = jest.fn(async () => "unused-fixture")
  const dispatch = jest.fn(async () => {
    throw Error("must not dispatch")
  })
  const runTrial = async (args: ResearchTrialInput) => {
    const cancelled = new AbortController()
    return runResearchTrial(
      {
        ...args,
        signal: cancelled.signal,
        onCall: async (event, signal) => {
          await args.onCall?.(event, signal)
          if (event.state === "admitted") cancelled.abort()
        },
      },
      {
        createTarget: () => ({ label: "never-dispatched", run: dispatch }),
        runTeam: (input, deps) => runIsolatedTeamEval(input, { ...deps, runMember: dispatch }),
      }
    )
  }
  const log = jest.spyOn(console, "log").mockImplementation(() => {})
  try {
    const options = fixtureOptions(dir)
    const deps = { loadSource: fixtureSource, diskPolicy, readCredential, runTrial }
    expect(await runBenchmark(options, {}, deps)).toBe(1)
    expect(dispatch).not.toHaveBeenCalled()
    const result = JSON.parse(await fs.readFile(path.join(dir, "results.json"), "utf8"))
    expect(result.finishedTrials).toBe(3)
    expect(
      result.summary.every(
        (row: { solverTokens: { unknownLiabilityCalls: number; total: number } }) =>
          row.solverTokens.unknownLiabilityCalls >= 1 && row.solverTokens.total === 0
      )
    ).toBe(true)
    const manifest = JSON.parse(await fs.readFile(path.join(dir, "manifest.json"), "utf8"))
    readCredential.mockClear()
    expect(await runBenchmark(options, {}, deps, { manifest, retryInterrupted: false })).toBe(1)
    expect(readCredential).not.toHaveBeenCalled()
  } finally {
    log.mockRestore()
  }
})

it.each(["phase", "agentId", "taskId", "judgmentKind"])(
  "rejects a settlement with mismatched %s",
  (key) => {
    const at = new Date().toISOString()
    const admission =
      key === "judgmentKind"
        ? { state: "admitted", phase: "judge", callId: "c", judgmentKind: "research" }
        : { state: "admitted", phase: "solver", callId: "c", agentId: "a", taskId: "t" }
    const patch =
      key === "phase"
        ? { phase: "judge", agentId: undefined, taskId: undefined, judgmentKind: "research" }
        : key === "judgmentKind"
          ? { judgmentKind: "milestones" }
          : { [key]: "other" }
    expect(() =>
      replayBenchmarkJournal([
        {
          kind: "attempt-started",
          attemptId: "a",
          at,
          entry: { caseId: "1", variant: "single-agent", repetition: 1 },
        },
        { kind: "call", attemptId: "a", at, call: admission },
        {
          kind: "call",
          attemptId: "a",
          at,
          call: { ...admission, ...patch, state: "settled", sample: callSample() },
        },
      ])
    ).toThrow(/identity mismatch/)
  }
)
