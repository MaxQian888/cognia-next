/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import { readFileSync } from "node:fs"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { enqueueOutboundMany } from "@/lib/db/outbound-jobs"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import type { OutboundResult, PlatformAdapter } from "@/types/connectors"
import { MAX_ACTIVE_PLATFORM_SENDS, startOutboundRunner } from "./outbound-runner"

jest.mock("@/lib/plugin/messaging/hooks-system", () => ({
  getPluginEventHooks: () => ({
    dispatchConnectorDecision: async () => ({ action: "allow" }),
  }),
}))
jest.mock("@/lib/telemetry/events/track-event", () => ({ trackEvent: async () => true }))
jest.mock("@/lib/telemetry/inbox-events", () => ({ trackInboxEvent: async () => true }))
jest.mock("@/lib/connectors/audit", () => ({ appendAudit: async () => undefined }))
jest.mock("@/lib/db/conversation-overrides", () => ({
  markResponded: async () => undefined,
  readForResolution: async () => null,
  wakeSnoozedConversations: async () => undefined,
}))

const RUNS = Number(process.env.CONNECTOR_BENCHMARK_RUNS ?? 20)
const JOB_COUNT = Number(process.env.CONNECTOR_BENCHMARK_JOBS ?? 1_000)
const benchmarkEnabled = process.env.CONNECTOR_BENCHMARK === "1"
const benchmarkDescribe = benchmarkEnabled ? describe : describe.skip
const fixture = createDbTestFixture({ seeded: false })

interface BenchmarkSample {
  durationMs: number
  heapDeltaBytes: number
}

interface BenchmarkResult {
  durationMs: number
  heapDeltaBytes: number
}

interface BenchmarkBaseline {
  oneConversation: BenchmarkResult
  thousandConversations: BenchmarkResult
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0)
}

function summarize(samples: BenchmarkSample[]): BenchmarkResult {
  return {
    durationMs: median(samples.map((sample) => sample.durationMs)),
    heapDeltaBytes: median(samples.map((sample) => sample.heapDeltaBytes)),
  }
}

async function seedAdapter(adapterId: string): Promise<void> {
  await getDb().adapterInstances.put({
    id: adapterId,
    type: "telegram",
    displayName: "Benchmark adapter",
    enabled: true,
    transportMode: "webhook",
    settings: {},
    credentialsRef: { keyringService: "com.cognia.platforms", accounts: [] },
    trigger: { rules: [], blockers: [], storeUnmatchedInDraftMode: false },
    defaultMode: "auto",
    outboundTuning: { rateCapacity: 2_000, rateRefillPerSec: 2_000 },
    createdAt: 1,
    updatedAt: 1,
  } as AdapterInstanceRow)
}

async function waitUntilSent(expected: number, timeoutMs = 10 * 60_000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while ((await getDb().outboundQueue.where("status").equals("sent").count()) < expected) {
    if (performance.now() >= deadline)
      throw new Error(`Timed out after delivering ${expected} jobs`)
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
}

async function runOnce(conversations: number): Promise<BenchmarkSample> {
  await fixture.restore()
  const adapterId = "benchmark-adapter"
  await seedAdapter(adapterId)
  const wireOrder: number[] = []
  let resolveWireComplete!: () => void
  const wireComplete = new Promise<void>((resolve) => {
    resolveWireComplete = resolve
  })
  let active = 0
  let maxActive = 0
  const adapter = {
    id: adapterId,
    meta: {
      type: "telegram",
      displayName: "Benchmark adapter",
      version: "1",
      capabilities: [],
      transportModes: ["stub"],
      configSchema: {},
    },
    start: async () => undefined,
    stop: async () => undefined,
    health: () => ({ state: "running" as const }),
    a2uiCapability: () => ({}) as never,
    send: async (request): Promise<OutboundResult> => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await Promise.resolve()
      wireOrder.push(Number(request.metadata.idempotencyKey.slice("benchmark-".length)))
      if (
        process.env.CONNECTOR_BENCHMARK_PROGRESS === "1" &&
        wireOrder.length % Math.max(1, Math.floor(JOB_COUNT / 10)) === 0
      ) {
        console.info(
          `[connector-benchmark] conversations=${conversations} sent=${wireOrder.length}`
        )
      }
      if (wireOrder.length === JOB_COUNT) resolveWireComplete()
      active -= 1
      return { ok: true, platformMessageId: request.metadata.idempotencyKey }
    },
  } satisfies PlatformAdapter

  const heapBefore = process.memoryUsage().heapUsed
  const startedAt = performance.now()
  await enqueueOutboundMany(
    Array.from({ length: JOB_COUNT }, (_, index) => ({
      adapterId,
      conversationKey: `telegram:${adapterId}:chat-${index % conversations}`,
      request: {
        conversationRef: { platform: "telegram" as const, adapterId },
        segments: [{ type: "text" as const, text: `message ${index}` }],
        metadata: { idempotencyKey: `benchmark-${index}` },
      },
      source: "workflow" as const,
    }))
  )

  const schedulerStates: Array<{ activeSends: number; laneCount: number; dueBatchSize: number }> =
    []
  const controller = new AbortController()
  const runner = startOutboundRunner({
    adapters: new Map([[adapterId, adapter]]),
    signal: controller.signal,
    pollIntervalMs: 1,
    jitter: () => 0,
    onSchedulerState: (state) => schedulerStates.push(state),
  })
  let wireTimeout: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    wireComplete,
    new Promise<never>((_, reject) => {
      wireTimeout = setTimeout(
        () => reject(new Error(`Timed out after delivering ${JOB_COUNT} jobs to the adapter`)),
        10 * 60_000
      )
    }),
  ]).finally(() => {
    if (wireTimeout !== undefined) clearTimeout(wireTimeout)
  })
  await waitUntilSent(JOB_COUNT)
  while (schedulerStates.at(-1)?.laneCount !== 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1))
  }
  controller.abort()
  await runner

  expect(wireOrder).toHaveLength(JOB_COUNT)
  expect(new Set(wireOrder).size).toBe(JOB_COUNT)
  if (conversations === 1) {
    expect(wireOrder).toEqual(Array.from({ length: JOB_COUNT }, (_, index) => index))
  }
  expect(maxActive).toBeLessThanOrEqual(MAX_ACTIVE_PLATFORM_SENDS)
  expect(Math.max(...schedulerStates.map((state) => state.activeSends))).toBeLessThanOrEqual(
    MAX_ACTIVE_PLATFORM_SENDS
  )
  expect(Math.max(...schedulerStates.map((state) => state.dueBatchSize))).toBeLessThanOrEqual(128)
  expect(schedulerStates.at(-1)?.laneCount).toBe(0)

  return {
    durationMs: performance.now() - startedAt,
    heapDeltaBytes: Math.max(0, process.memoryUsage().heapUsed - heapBefore),
  }
}

async function runScenario(conversations: number): Promise<BenchmarkResult> {
  await runOnce(conversations)
  const samples: BenchmarkSample[] = []
  for (let index = 0; index < RUNS; index += 1) samples.push(await runOnce(conversations))
  return summarize(samples)
}

function verifyBaseline(current: BenchmarkBaseline): void {
  const baselinePath = process.env.CONNECTOR_BENCHMARK_BASELINE
  if (!baselinePath) return
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as BenchmarkBaseline
  for (const scenario of ["oneConversation", "thousandConversations"] as const) {
    expect(current[scenario].durationMs).toBeLessThanOrEqual(baseline[scenario].durationMs * 1.1)
    expect(current[scenario].heapDeltaBytes).toBeLessThanOrEqual(
      baseline[scenario].heapDeltaBytes * 1.1
    )
  }
}

benchmarkDescribe("connector outbound benchmark", () => {
  jest.setTimeout(60 * 60_000)
  beforeAll(fixture.initialize)
  afterAll(fixture.dispose)

  it("runs 1,000-job single- and multi-conversation fixtures over 20 warm samples", async () => {
    const result: BenchmarkBaseline = {
      oneConversation: await runScenario(1),
      thousandConversations: await runScenario(JOB_COUNT),
    }
    verifyBaseline(result)
    console.info(`[connector-benchmark] ${JSON.stringify(result)}`)
  })
})
