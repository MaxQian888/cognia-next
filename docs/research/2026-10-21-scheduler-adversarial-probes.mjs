/** Offline regression probes after hardening; full lifecycle/file behavior lives in co-located Jest tests. */
import fs from "node:fs"
import { createRequire } from "node:module"
import { resolve } from "node:path"
const ts = createRequire(resolve("package.json"))("typescript")
import assert from "node:assert/strict"

function evaluate(path, resolve = () => ({})) {
  const code = ts.transpileModule(fs.readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const moduleShim = { exports: {} }
  new Function("require", "module", "exports", code)(resolve, moduleShim, moduleShim.exports)
  return moduleShim.exports
}

async function duplicateReentry() {
  const policy = evaluate("lib/scheduler/maintenance-tasks.ts")
  const { ensureMaintenanceSchedule } = evaluate("lib/scheduler/managed-tasks.ts", (id) => {
    if (id === "./errors") return evaluate("lib/scheduler/errors.ts")
    assert.equal(id, "./maintenance-tasks")
    return policy
  })
  const base = {
    type: "conversation-auto-archive",
    createdAt: new Date(0),
    notification: policy.SILENT_MAINTENANCE_NOTIFICATION,
    tags: ["system:conversation-archive"],
  }
  const rows = [
    { ...base, id: "canonical", status: "active" },
    { ...base, id: "duplicate", status: "active" },
  ]
  const scheduler = {
    getAllTasks: async () => structuredClone(rows),
    updateTask: async (id, patch) => {
      const row = rows.find((candidate) => candidate.id === id)
      Object.assign(row, patch)
      return structuredClone(row)
    },
    createTask: async () => assert.fail("No new row expected"),
  }
  const draft = {
    name: "Archive",
    type: base.type,
    trigger: { type: "interval", intervalMs: 60_000 },
  }
  await ensureMaintenanceSchedule(scheduler, draft)
  assert.equal(rows[1].status, "disabled")
  assert.equal(policy.isRetiredMaintenanceTask(rows[1]), true)
  await ensureMaintenanceSchedule(scheduler, draft)
  assert.equal(rows[0].status, "active")
  assert.equal(rows[1].status, "disabled")
  return {
    probe: "retired duplicate reconciliation (lifecycle API regressions: managed-tasks.test.ts)",
    activeCopies: rows.filter((row) => row.status === "active").length,
  }
}

async function diagnosticOutcome() {
  const { runProviderDiagnosticsRefreshClock } = evaluate("lib/provider-diagnostics/refresh.ts")
  const writes = []
  const result = await runProviderDiagnosticsRefreshClock({
    now: () => 1_000,
    isOnline: () => true,
    isVaultAvailable: () => true,
    listDueStates: async () => [
      {
        sourceId: "provider-reachability:fixture",
        providerId: "fixture",
        status: "scheduled",
        nextDueAt: 0,
        consecutiveFailures: 0,
      },
    ],
    putState: async (row) => {
      writes.push(row)
    },
    runFreeSource: async () => ({ code: "authentication" }),
    getThreshold: async () => undefined,
  })
  assert.deepEqual(result, {
    scanned: 1,
    refreshed: 0,
    paused: 1,
    attempted: 1,
    succeeded: 0,
    failed: 0,
    blocked: 1,
    skipped: 0,
  })
  assert.equal(writes.at(-1).status, "paused-auth")
  return {
    probe: "diagnostic aggregate versus source state",
    result,
    sourceStatus: writes.at(-1).status,
  }
}

async function backupCadence() {
  const now = Date.UTC(2026, 9, 21)
  const day = 86_400_000
  const db = { name: "fixture-account" }
  const policy = evaluate("lib/data/scheduler.ts")
  const locks = evaluate("lib/data/backup-write-lock.ts")
  const config = {
    enabled: true,
    intervalDays: 7,
    dirPath: "/fixture/backups",
    lastLocalRun: {
      scope: "fixture-scope",
      directory: "/fixture/backups",
      content: "interval-full-v1",
      completedAt: now - day,
    },
  }
  let observedDue
  const backup = evaluate("lib/data/backup-scheduler.ts", () => ({
    getDb: () => db,
    ...locks,
    sha256Hex: async () => "fixture-scope",
    getDefaultBackupPassphrase: async () => "fixture-key",
    getSettings: async () => ({ backupAutoSchedule: config }),
    getLatestSuccessful: () => assert.fail("History is not cadence authority"),
    shouldRunScheduledBackup: (args) => {
      observedDue = policy.shouldRunScheduledBackup(args)
      return false // Stop before filesystem/network/history writes.
    },
  }))
  const options = { filesystem: null, messages: {}, now: () => new Date(now) }
  await backup.runScheduledBackupOnce(options)
  assert.equal(observedDue, false)
  config.lastLocalRun.completedAt = now - 10 * day
  await backup.runScheduledBackupOnce(options)
  assert.equal(observedDue, true)
  config.lastLocalRun.completedAt = now - day
  config.dirPath = "/fixture/changed-destination"
  await backup.runScheduledBackupOnce(options)
  assert.equal(observedDue, true)
  return {
    probe: "durable owner/destination interval cadence",
    recentSuppresses: true,
    expiredRuns: true,
    destinationChangeRuns: true,
    historyReads: 0,
  }
}

async function main() {
  // No production module is imported, no runtime is started, no data is written.
  for (const probe of [duplicateReentry, diagnosticOutcome, backupCadence])
    console.log(JSON.stringify(await probe()))
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
