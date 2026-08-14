/**
 * `cognia eval replay` orchestration (ADR-0118).
 *
 * Loads a fixture, boots the loopback tape server, drives the scenario, and
 * then refuses to call the run a success unless every tape was consumed and
 * nothing was left open.
 *
 * The driver is injected. Canonical replay needs no agent at all; runtime
 * replay needs the real CLI agent session, which is a much heavier dependency
 * and one this module deliberately does not reach for itself — it hands the
 * driver a per-actor base URL and lets the caller decide what to spawn.
 */

import {
  createReplayLedger,
  formatConsumptionReport,
  type ReplayConsumptionReport,
  type ReplayLedger,
  type RunnerLooseEnds,
} from "@/lib/ai/replay/lease"
import {
  createInlineChunkResolver,
  loadReplayFixture,
  replayAvailability,
  type ReplayFixtureV1,
} from "@/lib/ai/replay/fixture"
import { createTapeServer, type TapeServer } from "./tape-server"

export interface ReplayDriverContext {
  fixture: ReplayFixtureV1
  server: TapeServer
  ledger: ReplayLedger
}

/**
 * Runs the scenario's input steps against the booted server.
 *
 * Returns the loose ends only it can know about — permissions the scenario
 * scripted but the run never asked for, children that never finished, log rows
 * with no parent.
 */
export type ReplayDriver = (context: ReplayDriverContext) => Promise<RunnerLooseEnds>

export interface RunReplayOptions {
  /** Parsed fixture JSON. */
  raw: unknown
  /** Refuse real recordings. On for anything read out of the repository. */
  requireSynthetic?: boolean
  /** The host this process can offer; runtime replay needs tauri or headless. */
  platform?: "browser" | "tauri" | "headless"
  driver: ReplayDriver
  provider?: string
}

export interface RunReplayResult {
  ok: boolean
  scenarioId?: string
  report?: ReplayConsumptionReport
  /** Populated when the fixture or host refused the run before it started. */
  errors?: string[]
  requests: number
  unmatched: number
  summary: string
}

export async function runReplay(options: RunReplayOptions): Promise<RunReplayResult> {
  const loaded = loadReplayFixture(options.raw, {
    requireSynthetic: options.requireSynthetic ?? true,
  })
  if (!loaded.ok) {
    return {
      ok: false,
      errors: loaded.errors,
      requests: 0,
      unmatched: 0,
      summary: `fixture rejected:\n${loaded.errors.map((error) => `  - ${error}`).join("\n")}`,
    }
  }

  const fixture = loaded.value
  const availability = replayAvailability(fixture.scenario, {
    platform: options.platform ?? "headless",
  })
  if (!availability.runnable) {
    return {
      ok: false,
      scenarioId: fixture.scenario.scenarioId,
      errors: [availability.reason],
      requests: 0,
      unmatched: 0,
      summary: availability.reason,
    }
  }

  let ledger: ReplayLedger
  try {
    ledger = createReplayLedger(fixture.tapes)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      scenarioId: fixture.scenario.scenarioId,
      errors: [message],
      requests: 0,
      unmatched: 0,
      summary: message,
    }
  }

  const server = createTapeServer({
    ledger,
    resolveChunks: createInlineChunkResolver(fixture),
    provider: options.provider,
    defaultActorRef: fixture.scenario.actors.find((actor) => actor.role === "root")?.actorRef,
  })

  await server.start()
  let looseEnds: RunnerLooseEnds = {}
  let driverError: string | undefined
  try {
    looseEnds = await options.driver({ fixture, server, ledger })
  } catch (error) {
    driverError = error instanceof Error ? error.message : String(error)
  } finally {
    await server.stop()
  }

  // The consumption check runs even when the driver threw: a crash halfway
  // through is exactly when knowing which tapes went unused is most useful.
  const report = fixture.scenario.expectations.assertConsumed
    ? ledger.assertConsumed(looseEnds)
    : { ok: true, problems: [] }

  const unmatched = server.handled.filter((entry) => !entry.matched).length
  const ok = report.ok && !driverError

  const summary = [
    `${fixture.scenario.scenarioId}: ${server.handled.length} model request(s), ${unmatched} unmatched`,
    driverError ? `driver failed: ${driverError}` : undefined,
    fixture.scenario.expectations.assertConsumed
      ? formatConsumptionReport(report)
      : "assertConsumed disabled for this scenario",
  ]
    .filter(Boolean)
    .join("\n")

  return {
    ok,
    scenarioId: fixture.scenario.scenarioId,
    report,
    errors: driverError ? [driverError] : undefined,
    requests: server.handled.length,
    unmatched,
    summary,
  }
}

/**
 * Driver for `level: "canonical"`.
 *
 * Canonical replay validates the durable event log, not the provider, so it
 * makes no model calls at all. A canonical fixture carrying tapes is therefore
 * an authoring mistake, and `assertConsumed` will surface every one of them as
 * unconsumed rather than letting the scenario pass vacuously.
 */
export const canonicalDriver: ReplayDriver = async () => ({})
