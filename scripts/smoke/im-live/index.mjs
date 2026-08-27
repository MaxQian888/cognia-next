#!/usr/bin/env node
//
// Live IM harness: drive a real conversation on a real platform against the
// Cognia bot the operator already has configured, with the model swapped for a
// deterministic fixture.
//
//   pnpm im:test:target                        # terminal 1 — app + fixture
//   pnpm im:test:doctor -- --platform telegram # terminal 2 — preflight only
//   pnpm im:test:live   -- --platform telegram # terminal 2 — the P0 scenario
//
// Flags:
//   --platform <telegram|slack|discord|lark|matrix|all>   default: all
//   --allow-unconfigured   report missing platforms as NOT_CONFIGURED instead
//                          of refusing to start
//   --doctor               run the preflight only, post nothing
//
// Credentials come from the environment, optionally via `.env.im-live.local`.
// Exit 0 when nothing failed, 1 otherwise. See
// docs/content/docs/en/connectors/local-live-testing.mdx.

import process from "node:process"
import { fileURLToPath } from "node:url"

import { STATUS } from "./diagnose.mjs"
import {
  PLATFORMS,
  loadImLiveEnv,
  readConfig,
  registerConfigSecrets,
  selectPlatforms,
} from "./config.mjs"
import { checkFixture, doctorPlatform, formatChecks } from "./doctor.mjs"
import { createDriver } from "./drivers/index.mjs"
import { createFixtureClient, discoverFixture } from "./fixture-client.mjs"
import { LockHeldError, acquireLock } from "./lock.mjs"
import { createRedactor } from "./redact.mjs"
import { createRunReport, summarize, writeRunReport } from "./report.mjs"
import { formatDiagnosis } from "./diagnose.mjs"
import { newRunId } from "./marker.mjs"
import { runPlatform } from "./run.mjs"

export function parseArgs(argv) {
  const args = { platform: "all", allowUnconfigured: false, doctorOnly: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--platform") {
      args.platform = argv[++i]
      if (!args.platform) throw new Error("--platform needs a value")
      continue
    }
    if (arg.startsWith("--platform=")) {
      args.platform = arg.slice("--platform=".length)
      continue
    }
    if (arg === "--allow-unconfigured") {
      args.allowUnconfigured = true
      continue
    }
    if (arg === "--doctor") {
      args.doctorOnly = true
      continue
    }
    if (arg === "--") continue
    throw new Error(
      `unknown argument ${JSON.stringify(arg)}. ` +
        `Usage: --platform <${PLATFORMS.join("|")}|all> [--allow-unconfigured] [--doctor]`
    )
  }
  return args
}

/**
 * The whole run.
 *
 * Every side-effecting dependency is injectable so the orchestration — which
 * platforms run, what happens when one is unconfigured, whether a held lock
 * stops the rest — is testable without a network.
 */
export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  log = console.log,
  logError = console.error,
  loadEnv = loadImLiveEnv,
  discover = discoverFixture,
  makeFixture = createFixtureClient,
  makeDriver = createDriver,
  runOne = runPlatform,
  writeReport = writeRunReport,
  lockImpl = acquireLock,
  makeRunId = newRunId,
} = {}) {
  const args = parseArgs(argv)
  loadEnv()
  const config = readConfig(env)
  const redactor = registerConfigSecrets(config, createRedactor())
  const say = (message) => log(redactor.redactString(String(message)))
  const complain = (message) => logError(redactor.redactString(String(message)))

  const { requested, unconfigured } = selectPlatforms(config, args)
  const skipped = new Set(unconfigured)

  const fixtureTarget = await discover(config)
  const fixture = makeFixture({ baseUrl: fixtureTarget.baseUrl, token: fixtureTarget.token })
  const fixtureCheck = await checkFixture(fixture)
  say(`[im-live] fixture: ${fixtureCheck.ok ? "ok" : "FAIL"} — ${fixtureCheck.detail}`)
  if (!fixtureCheck.ok) {
    complain("[im-live] cannot continue without the deterministic model fixture.")
    return 1
  }

  const results = []
  for (const platform of requested) {
    if (skipped.has(platform)) {
      say(
        `[im-live] ${platform}: NOT_CONFIGURED (missing ${config.platforms[platform].missing.join(", ")})`
      )
      results.push({ platform, status: STATUS.NOT_CONFIGURED })
      continue
    }

    const values = config.platforms[platform].values
    const driver = makeDriver(platform, { values })
    const runId = makeRunId()

    if (args.doctorOnly) {
      const outcome = await doctorPlatform({ platform, driver })
      say(formatChecks(platform, outcome.checks))
      results.push({ platform, status: outcome.status })
      continue
    }

    // One runner per conversation. Two in the same chat corrupt each other's
    // assertions, and on Lark they also split the platform's event delivery.
    let lock
    try {
      lock = lockImpl({
        outputDir: config.outputDir,
        platform,
        conversationId: driver.conversationId,
        runId,
        ttlMs: config.lockTtlMs,
      })
    } catch (error) {
      if (!(error instanceof LockHeldError)) throw error
      complain(`[im-live] ${platform}: ${error.message}`)
      results.push({ platform, status: STATUS.FAIL })
      continue
    }

    const report = createRunReport({ platform, runId })
    report.recordLock({ file: lock.file, stoleFrom: lock.stoleFrom })
    if (lock.stoleFrom)
      say(`[im-live] ${platform}: took over a stale lock from pid ${lock.stoleFrom}`)
    say(`[im-live] ${platform}: run ${runId} in ${driver.conversationId}`)

    let payload
    try {
      payload = await runOne({
        driver,
        fixture,
        report,
        runId,
        platform,
        turnTimeoutMs: config.turnTimeoutMs,
        duplicateWindowMs: config.duplicateWindowMs,
        cleanup: config.cleanup,
      })
    } catch (error) {
      payload = report.finish(STATUS.FAIL, redactor.redactString(String(error?.message ?? error)))
    } finally {
      lock.release()
    }

    const file = await writeReport({ outputDir: config.outputDir, report, redactor })
    say(`[im-live] ${platform}: ${payload.status} → ${file}`)
    for (const turn of payload.turns) {
      if (turn.status === STATUS.PASS) continue
      complain(formatDiagnosis(turn))
    }
    if (payload.error) complain(`[im-live] ${platform}: ${payload.error}`)
    if (payload.cleanup?.retained?.length > 0) {
      complain(
        `[im-live] ${platform}: ${payload.cleanup.retained.length} test message(s) could not be removed — ` +
          `delete them by hand: ${payload.cleanup.retained.map((r) => r.id).join(", ")}`
      )
    }
    results.push({ platform, status: payload.status })
  }

  const summary = summarize(results)
  say(`[im-live] ${summary.line}`)
  return summary.exitCode
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main()
  } catch (error) {
    console.error(`[im-live] FAIL: ${error?.message ?? error}`)
    process.exitCode = 1
  }
}
