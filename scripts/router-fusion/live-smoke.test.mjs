// node --test scripts/router-fusion/live-smoke.test.mjs
//
// Proves the live smoke harness end to end through its real entry point —
// the script `pnpm router-fusion:live-smoke` runs — without any provider:
// --fake runs every case against the Fake Provider with the network blocked,
// the default dry run routes the cases and exits, and --confirm without a
// settings export refuses to start. Nothing here can reach a provider.

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, describe, it } from "node:test"

import { nodeIo, ROOT } from "./live-smoke.mjs"

const SCRIPT = path.join(ROOT, "scripts/router-fusion/live-smoke.mjs")
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "live-smoke-test-"))
const cleanup = [scratch]

after(() => {
  for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true })
})

/** The parent's environment without anything the harness would read. */
function cleanEnv(extra = {}) {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith("COGNIA_LIVE_SMOKE_")) delete env[key]
  return { ...env, ...extra }
}

function run(args, extraEnv = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: cleanEnv(extraEnv),
    encoding: "utf8",
    timeout: 240_000,
  })
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}

describe("router-fusion:live-smoke", () => {
  it("is the package.json script, and that command runs the harness", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"))
    const command = pkg.scripts["router-fusion:live-smoke"]
    assert.equal(command, "node scripts/router-fusion/live-smoke.mjs")
    const [binary, script] = command.split(" ")
    assert.equal(binary, "node")
    const result = spawnSync(process.execPath, [path.join(ROOT, script), "--help"], {
      cwd: ROOT,
      env: cleanEnv(),
      encoding: "utf8",
      timeout: 240_000,
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Usage: pnpm router-fusion:live-smoke/)
  })

  it("--fake runs every case through the engine against the Fake Provider and writes a simulated report", () => {
    const out = path.join(scratch, "fake-report")
    const { code, stdout, stderr } = run(["--fake", "--out", out])
    assert.equal(code, 0, `${stdout}\n${stderr}`)
    assert.match(stdout, /SIMULATED \(Fake Provider, network blocked\)/)
    assert.ok(stdout.includes(`Report (simulated): ${out}`), stdout)

    const report = JSON.parse(fs.readFileSync(path.join(out, "live-smoke-report.json"), "utf8"))
    if (report.fixtureRoot) cleanup.push(report.fixtureRoot)
    assert.equal(report.schema, "cognia-router-fusion-live-smoke")
    assert.equal(report.label, "simulated")
    assert.match(report.disclaimer, /no claim about real quality, latency, cost or savings/)
    assert.deepEqual(
      report.cases.map((entry) => [entry.id, entry.outcome]),
      [
        ["direct", "succeeded"],
        ["cascade", "succeeded"],
        ["panel", "succeeded"],
        ["delegate", "skipped"],
      ]
    )
    const delegate = report.cases.find((entry) => entry.id === "delegate")
    assert.equal(delegate.detail, "skipped: delegate not available in this build")
    assert.ok(delegate.reasons.includes("delegate_code:SANDBOX_UNAVAILABLE"), delegate.reasons)
    // The cap was proven in place by the ledger, and the ledger booked the spend.
    assert.equal(report.capEnforcement.ledgerProbe, "refused_over_cap")
    assert.equal(report.totalCapMicrousd, 5_000_000)
    const spent = report.cases.reduce((sum, entry) => sum + entry.spentMicrousd, 0)
    assert.equal(report.totalSpentMicrousd, spent)
    assert.ok(spent > 0 && spent <= report.totalCapMicrousd)
    // Usage buckets, request ids and retry observability for every call.
    for (const entry of report.cases.filter((c) => c.outcome === "succeeded")) {
      assert.ok(entry.calls.length > 0)
      assert.equal(entry.retry.unledgeredCalls, 0)
      assert.equal(entry.retry.executorCalls, entry.calls.length)
      for (const call of entry.calls) {
        assert.match(call.providerRequestId, /^mock:/)
        assert.ok(call.usage && call.usage.output > 0)
      }
    }
    // No network, and no fixture left un-written.
    assert.deepEqual(report.network, { mode: "blocked", requests: 0, blocked: 0 })
    assert.ok(fs.existsSync(path.join(report.fixtureRoot, ".cognia/workspace.json")))
    const markdown = fs.readFileSync(path.join(out, "live-smoke-report.md"), "utf8")
    assert.match(markdown, /^# Router \+ Fusion live smoke: SIMULATED/)
  })

  it("the default dry run routes the cases from a settings export and exits without a network call", () => {
    const settings = path.join(scratch, "export.json")
    fs.writeFileSync(
      settings,
      JSON.stringify({
        schema: "cognia-settings",
        version: 1,
        settings: {
          providerSettings: {
            openai: {
              providerId: "openai",
              enabled: true,
              defaultModel: "gpt-4o",
              discoveredModels: [{ id: "gpt-4o", supportsStructuredOutput: true }],
            },
          },
          modelMappings: ["fast", "balanced", "powerful"].map((alias) => ({
            id: `m-${alias}`,
            alias,
            providers: [{ providerId: "openai", modelId: "gpt-4o" }],
            distribution: "priority",
            enabled: true,
            createdAt: 0,
            updatedAt: 0,
          })),
        },
      })
    )
    const { code, stdout, stderr } = run(["--settings", settings], {
      COGNIA_LIVE_SMOKE_KEY_OPENAI: "sk-test-not-used",
    })
    assert.equal(code, 0, `${stdout}\n${stderr}`)
    assert.match(stdout, /DRY RUN \(network blocked, nothing is spent\)/)
    assert.match(stdout, /\[x\] openai/)
    assert.match(stdout, /→ direct_baseline: solver=openai::gpt-4o/)
    assert.match(stdout, /delegate .*\n.*skipped: delegate not available in this build/)
    assert.match(stdout, /Network requests during this dry run: 0/)
    assert.doesNotMatch(stdout, /Report \(/)
  })

  it("--confirm without a settings export refuses to start with exit code 2", () => {
    const { code, stderr } = run(["--confirm"])
    assert.equal(code, 2)
    assert.match(stderr, /refusing to start: --confirm needs the settings export/)
  })
})

describe("nodeIo", () => {
  it("writes a file with its parent directories and reads it back", async () => {
    const io = nodeIo()
    const file = io.resolvePath(scratch, "a/b/c.txt")
    await io.writeText(file, "hello")
    assert.equal(await io.readText(file), "hello")
    const temp = await io.makeTempDir("live-smoke-io-")
    cleanup.push(temp)
    assert.ok(temp.startsWith(os.tmpdir()))
    assert.equal(io.tempRoot, os.tmpdir())
  })
})
