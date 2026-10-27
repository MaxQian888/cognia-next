/** Node-owned benchmark I/O; kept distinct from the executable ESM launcher. */
import fs from "node:fs/promises"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { isDeepStrictEqual } from "node:util"
import { createHash, randomUUID } from "node:crypto"
import type { AppSettings } from "@cognia/agent-config-types"
import {
  MULTIAGENTBENCH_SOURCE,
  MULTIAGENTBENCH_PROFILE,
  MULTIAGENTBENCH_EVALUATION_PROTOCOL,
  parseResearchTasks,
  parseResearchRubrics,
  selectResearchTasks,
  type ResearchTask,
} from "@/lib/ai/eval/multiagentbench"
import { benchmarkSchedule, validateBenchmarkEndpoint } from "@/lib/ai/eval/benchmark-protocol"
import {
  runResearchTrial,
  summarizeResearchTrials,
  type ResearchTrial,
  type ResearchCallEvent,
} from "@/lib/ai/eval/multiagentbench-runtime"
import { BenchmarkStorage, BENCHMARK_DISK_POLICY } from "./multiagentbench-storage"
import {
  validateBenchmarkOptions,
  validateFrozenManifest,
  validateBenchmarkCall,
  validateBenchmarkTrial,
} from "./multiagentbench-validation"

export interface BenchmarkOptions {
  dryRun: boolean
  offline: boolean
  cases: number
  taskIds?: string[]
  repetitions: number
  seed: number
  timeoutMs: number
  judgeTimeoutMs: number
  tokenBudget: number
  judgeTokenBudget: number
  model: string
  judgeModel: string
  reasoningEffort: "low" | "medium" | "high"
  maxSolverOutputTokens: number
  maxJudgeOutputTokens: number
  baseURL: string
  sourceDir?: string
  runDir: string
  diagnostics: "all" | "primary" | "sampled"
  diagnosticEvery: number
}

type ScheduleEntry = ReturnType<typeof benchmarkSchedule>[number]
type JournalEvent =
  | { kind: "attempt-started"; attemptId: string; entry: ScheduleEntry; at: string }
  | { kind: "call"; attemptId: string; call: ResearchCallEvent; at: string }
  | { kind: "attempt-settled"; attemptId: string; trial: ResearchTrial; at: string }
const cellKey = (row: { caseId?: string; taskId?: string; variant: string; repetition: number }) =>
  `${row.caseId ?? row.taskId}:${row.variant}:${row.repetition}`

export function replayBenchmarkJournal(events: readonly Record<string, unknown>[]) {
  const attempts = new Map<
    string,
    {
      attemptId: string
      entry: ScheduleEntry
      trial?: ResearchTrial
      calls: Map<string, { admission: ResearchCallEvent; settlement?: ResearchCallEvent }>
    }
  >()
  const finished = new Map<string, ResearchTrial>()
  const callIds = new Set<string>()
  for (const raw of events) {
    const event = raw as JournalEvent
    if (typeof event.attemptId !== "string") throw Error("Journal event has no attempt ID")
    if (event.kind === "attempt-started") {
      if (
        attempts.has(event.attemptId) ||
        !event.entry ||
        typeof event.entry.caseId !== "string" ||
        !["single-agent", "serial-squad", "parallel-squad"].includes(event.entry.variant) ||
        !Number.isSafeInteger(event.entry.repetition) ||
        event.entry.repetition < 1 ||
        finished.has(cellKey(event.entry))
      )
        throw Error("Duplicate or invalid trial admission")
      attempts.set(event.attemptId, {
        attemptId: event.attemptId,
        entry: event.entry,
        calls: new Map(),
      })
      continue
    }
    const attempt = attempts.get(event.attemptId)
    if (!attempt || attempt.trial) throw Error("Journal event has no active attempt")
    if (event.kind === "call") {
      const call = event.call
      validateBenchmarkCall(call)
      const previous = attempt.calls.get(call.callId)
      if (call.state === "admitted" && !previous && !callIds.has(call.callId)) {
        callIds.add(call.callId)
        attempt.calls.set(call.callId, { admission: call })
      } else if (call.state === "settled" && previous && !previous.settlement) {
        for (const key of ["phase", "agentId", "taskId", "judgmentKind"] as const)
          if (call[key] !== previous.admission[key])
            throw Error("Call settlement identity mismatch")
        previous.settlement = call
      } else throw Error("Duplicate or unadmitted call settlement")
    } else if (event.kind === "attempt-settled") {
      validateBenchmarkTrial(event.trial)
      // A deadline can fire after durable admission but before dispatch. Keep
      // that unknown liability even when the failed trial itself has settled.
      if (
        !event.trial ||
        cellKey(event.trial) !== cellKey(attempt.entry) ||
        finished.has(cellKey(event.trial))
      )
        throw Error("Trial settlement does not match its admission")
      attempt.trial = event.trial
      finished.set(cellKey(event.trial), event.trial)
    } else throw Error("Unknown benchmark journal event")
  }
  return { attempts: [...attempts.values()], trials: [...finished.values()], finished }
}

export function summarizeBenchmarkJournal(events: readonly Record<string, unknown>[]) {
  const { attempts } = replayBenchmarkJournal(events)
  return (["single-agent", "serial-squad", "parallel-squad"] as const).map((variant) => {
    const rows = attempts.filter((row) => row.entry.variant === variant)
    const usage = (phase: "solver" | "judge") => {
      let input = 0,
        output = 0,
        cacheRead = 0,
        cacheWrite = 0,
        unknownLiabilityCalls = 0,
        measuredCalls = 0
      const calls = rows.flatMap((row) =>
        [...row.calls.values()].filter((call) => call.admission.phase === phase)
      )
      for (const call of calls) {
        const sample = call.settlement?.sample
        const availability = sample?.metricAvailability?.usage
        if (availability !== "known") unknownLiabilityCalls++
        else measuredCalls++
        if (sample && (availability === "known" || availability === "partial")) {
          input += sample.usage.inputTokens
          output += sample.usage.outputTokens
          cacheRead += sample.usage.cacheReadTokens
          cacheWrite += sample.usage.cacheCreationTokens
        }
      }
      return {
        input,
        output,
        total: input + output,
        cacheRead,
        cacheWrite,
        admittedCalls: calls.length,
        measuredCalls,
        unknownLiabilityCalls,
        totalsAreLowerBounds: unknownLiabilityCalls > 0,
      }
    }
    return {
      variant,
      attemptedTrials: rows.length,
      completedTrials: rows.filter((row) => row.trial?.solver.status === "completed").length,
      interruptedTrials: rows.filter((row) => !row.trial).length,
      solverTokens: usage("solver"),
      judgeTokens: usage("judge"),
      currencyCost: null,
      costAvailability: "unavailable",
    }
  })
}

export function selectDiagnosticTaskIds(
  tasks: readonly ResearchTask[],
  every: number,
  seed: number
) {
  const selected = new Set<string>()
  for (const bucket of [0, 1, 2]) {
    const rows = tasks
      .filter((task) => (task.agents.length <= 3 ? 0 : task.agents.length <= 6 ? 1 : 2) === bucket)
      .map((task) => ({ task, hash: digest(Buffer.from(`${seed}:${task.taskId}`)) }))
      .sort((a, b) => a.hash.localeCompare(b.hash))
    rows.forEach((row, index) => {
      if (index % every === 0) selected.add(row.task.taskId)
    })
  }
  return tasks.filter((task) => selected.has(task.taskId)).map((task) => task.taskId)
}

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

export function serializeBenchmarkArtifact(value: unknown, secret?: string, indent = 2): string {
  return (
    JSON.stringify(
      value,
      (_field, item: unknown) =>
        typeof item === "string" && secret ? item.replaceAll(secret, "[REDACTED_API_KEY]") : item,
      indent
    ) ?? "null"
  )
}

export async function readBenchmarkCredential(
  baseURL: string,
  explicitKey: string | undefined,
  readLocal: () => Promise<string> = async () => {
    try {
      const proxyCli =
        process.env.COGNIA_TEAM_EVAL_PROXY_CLI ?? path.resolve("../aiden-llm-proxy/dist/cli.js")
      await fs.access(proxyCli)
      return execFileSync(process.execPath, [proxyCli, "key"], {
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim()
    } catch {
      throw Error("Unable to read the local proxy credential; set COGNIA_TEAM_EVAL_API_KEY")
    }
  }
): Promise<string> {
  const endpoint = new URL(validateBenchmarkEndpoint(baseURL))
  let key = explicitKey
  if (key === undefined) {
    if (
      endpoint.protocol !== "http:" ||
      endpoint.hostname !== "127.0.0.1" ||
      endpoint.port !== "8787" ||
      endpoint.pathname.replace(/\/$/, "") !== "/v1"
    )
      throw Error("Custom endpoints require an explicit COGNIA_TEAM_EVAL_API_KEY")
    key = await readLocal()
  }
  if (!key.trim()) throw Error("The proxy credential is empty")
  return key
}

export async function loadPinnedFile(
  pin: { path: string; sha256: string },
  options: { sourceDir: string; offline: boolean },
  request: typeof fetch = fetch
): Promise<string> {
  const file = path.join(options.sourceDir, pin.path)
  const verify = (bytes: Uint8Array) => {
    if (digest(bytes) !== pin.sha256) throw Error(`Pinned source checksum mismatch: ${pin.path}`)
    return Buffer.from(bytes).toString("utf8")
  }
  try {
    return verify(await fs.readFile(file))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  if (options.offline) throw Error(`Pinned source is not cached: ${pin.path}`)
  const url = `https://raw.githubusercontent.com/ulab-uiuc/MARBLE/${MULTIAGENTBENCH_SOURCE.revision}/${pin.path}`
  const response = await request(url, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok || !response.body)
    throw Error(`Pinned source request failed: ${response.status} ${pin.path}`)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  for (;;) {
    const part = await reader.read()
    if (part.done) break
    length += part.value.byteLength
    if (length > 3_000_000) {
      await reader.cancel()
      throw Error("Pinned source exceeds download limit")
    }
    chunks.push(part.value)
  }
  const bytes = Buffer.concat(chunks)
  const content = verify(bytes)
  await fs.mkdir(path.dirname(file), { recursive: true })
  try {
    await fs.writeFile(file, bytes, { flag: "wx" })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    verify(await fs.readFile(file))
  }
  return content
}

export async function runBenchmark(
  options: BenchmarkOptions,
  sourceManifest: unknown,
  overrides: Partial<BenchmarkRunDeps> = {},
  resume?: { manifest: Record<string, unknown>; retryInterrupted: boolean }
): Promise<number> {
  const deps = {
    runTrial: runResearchTrial,
    readCredential: readBenchmarkCredential,
    loadSource: loadPinnedFile,
    diskPolicy: BENCHMARK_DISK_POLICY,
    ...overrides,
  }
  options = validateBenchmarkOptions(options)
  const baseURL = options.baseURL
  const sourceDir = path.resolve(
    options.sourceDir ?? `.cache/multiagentbench/upstream/${MULTIAGENTBENCH_SOURCE.revision}`
  )
  const sourceOptions = { sourceDir, offline: options.offline }
  const [researchText, rubricsText, license] = await Promise.all([
    deps.loadSource(MULTIAGENTBENCH_SOURCE.research, sourceOptions),
    deps.loadSource(MULTIAGENTBENCH_SOURCE.rubrics, sourceOptions),
    deps.loadSource(MULTIAGENTBENCH_SOURCE.license, sourceOptions),
  ])
  const allTasks = parseResearchTasks(researchText)
  if (allTasks.length !== MULTIAGENTBENCH_SOURCE.research.records)
    throw Error("Pinned public research split has an unexpected task count")
  const tasks = selectResearchTasks(allTasks, options.cases, options.taskIds)
  const rubrics = parseResearchRubrics(rubricsText)
  const schedule = benchmarkSchedule(
    tasks.map((task) => task.taskId),
    options.repetitions,
    options.seed
  )
  const diagnosticTaskIds =
    options.diagnostics === "all"
      ? tasks.map((task) => task.taskId)
      : options.diagnostics === "primary"
        ? []
        : selectDiagnosticTaskIds(tasks, options.diagnosticEvery, options.seed)
  const planned = {
    schema: "cognia.multiagentbench-research/v3",
    executionOptions: { ...options, sourceDir },
    evaluationProtocol: MULTIAGENTBENCH_EVALUATION_PROTOCOL,
    datasetUnits: {
      records: tasks.length,
      uniqueIntroductions: new Set(tasks.map((task) => task.content)).size,
      uniqueCompleteConfigurations: new Set(
        tasks.map(({ content, outputFormat, agents }) =>
          digest(Buffer.from(JSON.stringify({ content, outputFormat, agents })))
        )
      ).size,
      primaryWeighting: "source-record",
      sensitivityWeighting: "equal-introduction-cluster",
    },
    diagnostics: {
      policy: options.diagnostics,
      every: options.diagnosticEvery,
      selectedTaskIds: diagnosticTaskIds,
      strata: "public-role-count:1-3,4-6,7+",
      pairedAcrossVariants: true,
    },
    durability: {
      journal: "events.ndjson",
      diskPolicy: deps.diskPolicy,
      retryInterrupted: "explicit opt-in only",
    },
    createdAt: new Date().toISOString(),
    mode: options.dryRun ? "dry-run" : "live",
    profile: MULTIAGENTBENCH_PROFILE,
    source: MULTIAGENTBENCH_SOURCE,
    sourceManifest,
    model: options.model,
    judgeModel: options.judgeModel,
    baseURL,
    informationPolicy:
      "Single Agent receives the union of public role profiles; Squad members receive their assigned public profiles and task dependencies.",
    environment: {
      externalLiteratureTools: false,
      nativeTools: false,
      productionStateWrites: false,
    },
    scorePolicy:
      "Source 1-5 research criteria with bounded reasons and verbatim proposal quotes; strict JSON validation; execution, five-question structure and quality are separate. Dependency-payload communication and milestones are optional diagnostics.",
    decisionPolicy: {
      formalSelection: false,
      judgeCalibration: "not-performed",
      interpretation: "descriptive pilot only",
    },
    budget: {
      solverTokens: options.tokenBudget,
      judgeTokens: options.judgeTokenBudget,
      maxOutputPerSolverCall: options.maxSolverOutputTokens,
      maxOutputPerJudgeCall: options.maxJudgeOutputTokens,
    },
    protocol: {
      repetitions: options.repetitions,
      seed: options.seed,
      outerConcurrency: 1,
      maxParallelMembers: 5,
      timeoutMs: options.timeoutMs,
      judgeTimeoutMs: options.judgeTimeoutMs,
      implicitRetries: 0,
      reasoningEffort: options.reasoningEffort,
    },
    currencyCostAvailable: false,
    schedule,
    tasks,
  }
  const manifest = resume?.manifest ?? planned
  if (resume) validateFrozenManifest(manifest, planned)
  const storage = await BenchmarkStorage.open(options.runDir, deps.diskPolicy)
  const controller = new AbortController()
  const interrupt = () => controller.abort(new DOMException("Benchmark interrupted", "AbortError"))
  process.on("SIGINT", interrupt)
  process.on("SIGTERM", interrupt)
  let key: string | undefined
  const json = (value: unknown, indent = 2) => serializeBenchmarkArtifact(value, key, indent)
  const events: Record<string, unknown>[] = []
  const recoveryEvents: JournalEvent[] = []
  let persistenceError: string | undefined
  let complete = false
  let finalError: unknown
  let initialized = false
  const record = async (event: JournalEvent) => {
    const safe = JSON.parse(json(event, 0)) as Record<string, unknown>
    if (event.kind === "call") validateBenchmarkCall(safe.call)
    if (event.kind === "attempt-settled") validateBenchmarkTrial(safe.trial)
    try {
      await storage.append(safe)
      events.push(safe)
    } catch (error) {
      // Settled provider responses can still be salvaged by the atomic snapshot.
      // Failed admission barriers never dispatch and are not counted as calls.
      if (
        event.kind === "attempt-settled" ||
        (event.kind === "call" && event.call.state === "settled")
      )
        recoveryEvents.push(safe as JournalEvent)
      persistenceError = error instanceof Error ? error.message : String(error)
      controller.abort(new Error("evidence_persistence_failed"))
      throw error
    }
  }
  const eventKey = (row: Record<string, unknown>) => {
    const event = row as JournalEvent
    return event.kind === "call"
      ? `${event.attemptId}:call:${event.call.callId}:${event.call.state}`
      : `${event.attemptId}:${event.kind}`
  }
  const validatedReplay = (records: readonly Record<string, unknown>[]) => {
    const replay = replayBenchmarkJournal(records)
    for (const attempt of replay.attempts) {
      if (!schedule.some((row) => cellKey(row) === cellKey(attempt.entry)))
        throw Error("Journal contains an unscheduled trial")
    }
    return replay
  }
  const persist = async () => {
    const reconciled = [...events, ...recoveryEvents]
    const replay = validatedReplay(reconciled)
    const payload = {
      manifest,
      complete,
      plannedTrials: schedule.length,
      finishedTrials: replay.trials.length,
      allAttemptedTrials: replay.attempts.length,
      primaryCellSummary: summarizeResearchTrials(replay.trials, tasks),
      summary: summarizeBenchmarkJournal(reconciled),
      interruptedAttempts: replay.attempts
        .filter((row) => !row.trial)
        .map((row) => ({
          attemptId: row.attemptId,
          ...row.entry,
          state: "interrupted",
          calls: [...row.calls.values()],
        })),
      recoveryEvents,
      persistenceError,
      trials: replay.trials,
    }
    await storage.snapshot(json(payload) + "\n")
    return payload
  }
  const outcome = (trials: ResearchTrial[]) =>
    complete &&
    trials.every(
      (trial) =>
        trial.solver.status === "completed" &&
        trial.judgments.some((row) => row.kind === "research" && row.status === "graded")
    )
      ? 0
      : 1
  try {
    if (!resume) {
      await fs.writeFile(path.join(options.runDir, "manifest.json"), json(manifest) + "\n", {
        flag: "wx",
      })
      initialized = true
      await fs.writeFile(path.join(options.runDir, "LICENSE.upstream"), license, { flag: "wx" })
    }
    if (options.dryRun) {
      console.log(
        json({
          dryRun: true,
          profile: manifest.profile,
          publicTasksValidated: allTasks.length,
          selectedTasks: tasks.length,
          plannedTrials: schedule.length,
          runDir: options.runDir,
        })
      )
      return 0
    }
    let previous: string | undefined
    const candidates: Record<string, unknown>[] = []
    if (resume) {
      // Read salvage first; validate the entire candidate before any tail repair/import.
      try {
        previous = await fs.readFile(path.join(options.runDir, "results.json"), "utf8")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
      if (previous) {
        const old: unknown = JSON.parse(previous)
        if (!old || typeof old !== "object" || Array.isArray(old))
          throw Error("Invalid recovery snapshot")
        const recovered = (old as { recoveryEvents?: unknown }).recoveryEvents
        if (recovered !== undefined && !Array.isArray(recovered))
          throw Error("Invalid recovery events")
        candidates.push(...((recovered ?? []) as Record<string, unknown>[]))
      }
    }
    events.push(
      ...(await storage.replay((records) => {
        const combined = [...records]
        for (const event of candidates) {
          const existing = combined.find((row) => eventKey(row) === eventKey(event))
          if (existing && !isDeepStrictEqual(existing, event))
            throw Error("Conflicting recovery evidence")
          if (!existing) {
            combined.push(event)
            recoveryEvents.push(event as JournalEvent)
          }
        }
        const checked = validatedReplay(combined)
        // Exercise both projections while the original bytes are still untouched.
        summarizeResearchTrials(checked.trials, tasks)
        summarizeBenchmarkJournal(combined)
      }))
    )
    if (previous) {
      await fs.writeFile(
        path.join(options.runDir, `snapshot-before-resume-${randomUUID()}.json`),
        previous,
        { flag: "wx" }
      )
      initialized = true
      while (recoveryEvents.length) {
        const event = recoveryEvents[0]!
        await storage.append(event)
        events.push(event)
        recoveryEvents.shift()
      }
    }
    const replay = validatedReplay(events)
    initialized = true
    complete = replay.finished.size === schedule.length
    await persist()
    if (complete) return outcome(replay.trials)
    if (replay.attempts.some((row) => !row.trial) && !resume?.retryInterrupted)
      throw Error(
        "Interrupted attempts retained with unknown call liabilities; use --resume PATH --retry-interrupted to authorize another attempt"
      )
    if (controller.signal.aborted || !(await storage.waitForSpace(controller.signal))) return 1
    key = await deps.readCredential(baseURL, process.env.COGNIA_TEAM_EVAL_API_KEY)
    const settings = {
      defaultProvider: "openai",
      defaultModel: options.model,
      providerSettings: {
        openai: {
          enabled: true,
          apiKey: key,
          baseURL,
          apiFlavor: "chat",
          defaultModel: options.model,
        },
      },
    } as unknown as AppSettings
    for (const entry of schedule) {
      if (replay.finished.has(cellKey(entry))) continue
      if (controller.signal.aborted || !(await storage.waitForSpace(controller.signal))) break
      const attemptId = randomUUID()
      await record({ kind: "attempt-started", attemptId, entry, at: new Date().toISOString() })
      const trial = await deps.runTrial({
        task: tasks.find((row) => row.taskId === entry.caseId)!,
        rubrics,
        variant: entry.variant,
        repetition: entry.repetition,
        settings,
        providerId: "openai",
        modelId: options.model,
        judgeModelId: options.judgeModel,
        timeoutMs: options.timeoutMs,
        judgeTimeoutMs: options.judgeTimeoutMs,
        tokenBudget: options.tokenBudget,
        judgeTokenBudget: options.judgeTokenBudget,
        maxSolverOutputTokens: options.maxSolverOutputTokens,
        maxJudgeOutputTokens: options.maxJudgeOutputTokens,
        reasoningEffort: options.reasoningEffort,
        diagnostics: diagnosticTaskIds.includes(entry.caseId),
        signal: controller.signal,
        onCall: async (call, callSignal) => {
          if (call.state === "admitted") {
            const signal = callSignal ?? controller.signal
            signal.throwIfAborted()
            if (!(await storage.waitForSpace(signal))) signal.throwIfAborted()
          }
          await record({ kind: "call", attemptId, call, at: new Date().toISOString() })
        },
      })
      try {
        await record({ kind: "attempt-settled", attemptId, trial, at: new Date().toISOString() })
      } finally {
        await persist()
      }
      replay.finished.set(cellKey(entry), trial)
      console.log(
        json({
          finished: replay.finished.size,
          planned: schedule.length,
          ...entry,
          status: trial.solver.status,
          structurePassed: trial.acceptance?.passed,
          wallTimeMs: trial.solver.wallTimeMs,
          ratings: trial.judgments.find((row) => row.kind === "research")?.ratings,
        })
      )
    }
    complete = replay.finished.size === schedule.length
    const payload = await persist()
    console.log(json({ complete, runDir: options.runDir, summary: payload.summary }))
    return outcome(payload.trials)
  } catch (error) {
    if (!initialized) {
      finalError = error
      throw error
    }
    let snapshotError: unknown
    try {
      await persist()
    } catch (caught) {
      snapshotError = caught
    }
    finalError = snapshotError
      ? new AggregateError(
          [error, snapshotError],
          "Benchmark failed and final evidence snapshot failed"
        )
      : error
    throw finalError
  } finally {
    process.off("SIGINT", interrupt)
    process.off("SIGTERM", interrupt)
    try {
      await storage.close()
    } catch (error) {
      if (finalError)
        throw new AggregateError(
          [finalError, error],
          "Benchmark failed and owned-resource cleanup failed"
        )
      throw error
    }
  }
}

export interface BenchmarkRunDeps {
  runTrial: typeof runResearchTrial
  readCredential: typeof readBenchmarkCredential
  loadSource: typeof loadPinnedFile
  diskPolicy: typeof BENCHMARK_DISK_POLICY
}

export async function resumeBenchmark(runDir: string, retryInterrupted = false): Promise<number> {
  const manifest = JSON.parse(
    await fs.readFile(path.join(runDir, "manifest.json"), "utf8")
  ) as Record<string, unknown>
  if (manifest.schema !== "cognia.multiagentbench-research/v3")
    throw Error(
      "This snapshot predates hardened resume v3; preserve it and use its frozen original runner"
    )
  const options = validateBenchmarkOptions(manifest.executionOptions)
  if (path.resolve(options.runDir) !== path.resolve(runDir))
    throw Error("Frozen run directory changed")
  return runBenchmark(options, manifest.sourceManifest, {}, { manifest, retryInterrupted })
}
