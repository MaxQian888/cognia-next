/** Real workerd/SQLite smoke check. All mail goes to a local receiver, never an inbox. */
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

const root = process.cwd()
const require = createRequire(resolve(root, "services/identity-server/package.json"))
const wranglerRequire = createRequire(require.resolve("wrangler/package.json"))
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire("miniflare")
const esbuild = wranglerRequire("esbuild")
const outputFlag = process.argv.indexOf("--output")
const cache = resolve(
  root,
  outputFlag === -1 ? ".cache/logto-email-hardening" : process.argv[outputFlag + 1]
)
await mkdir(cache, { recursive: true })
const token = "local-smoke-token-0123456789abcdef0123456789abcdef"
const sampleFlag = process.argv.indexOf("--samples")
const samples = sampleFlag === -1 ? 10 : Number(process.argv[sampleFlag + 1])
assert(Number.isInteger(samples) && samples >= 10 && samples <= 100, "--samples must be 10..100")
let submissions = 0
const receiver = createServer(async (request, response) => {
  let body = ""
  for await (const chunk of request) body += chunk
  const mail = JSON.parse(body)
  submissions++
  assert.equal(mail.from.email, "login@status.cognia.cn")
  const id = submissions
  setTimeout(
    () => {
      const failed = mail.to.startsWith("failure-")
      response.writeHead(failed ? 500 : 200, { "content-type": "application/json" })
      response.end(
        JSON.stringify(failed ? { error: "fixture failure" } : { messageId: `local-${id}` })
      )
    },
    mail.to.startsWith("slow-") ? 200 : 20
  )
})
await new Promise((done) => receiver.listen(0, "127.0.0.1", done))
const port = receiver.address().port

function median(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2
}
function summary(samples) {
  const value = median(samples)
  return { medianMs: value, madMs: median(samples.map((sample) => Math.abs(sample - value))) }
}

function runtimeConfig(bundle, label, coordinated) {
  return {
    resourcePersistencePath: resolve(cache, `runtime-state-${label}-${Date.now()}`),
    workers: [
      {
        name: "main",
        modules: true,
        scriptPath: bundle,
        compatibilityDate: "2026-09-25",
        bindings: {
          LOGTO_EMAIL_TOKEN: token,
          LOGTO_EMAIL_HASH_KEY: `${token}-hash`,
          MAIL_FROM: "login@status.cognia.cn",
        },
        serviceBindings: { EMAIL: { name: "receiver", entrypoint: "MailReceiver" } },
        ...(coordinated
          ? { durableObjects: { DELIVERY: { className: "EmailDelivery", useSQLite: true } } }
          : {}),
      },
      {
        name: "receiver",
        modules: true,
        compatibilityDate: "2026-09-25",
        script: `import { WorkerEntrypoint } from "cloudflare:workers";
        export class MailReceiver extends WorkerEntrypoint {
          async send(message) {
            const response = await fetch("http://127.0.0.1:${port}/mail", {
              method:"POST", body:JSON.stringify(message)
            });
            return response.json();
          }
        }
        export default {fetch(){return new Response("Not found",{status:404})}};`,
      },
    ],
  }
}

async function createHarness(label, source, coordinated, clock) {
  const bundle = resolve(cache, `${label}.mjs`)
  async function compile(path) {
    let entry = path
    if (clock !== undefined) {
      entry = resolve(cache, `${label}-clock.ts`)
      // Fixture-only clock: never included in a deployment or latency measurement.
      await writeFile(
        entry,
        `import worker from ${JSON.stringify(path)};
        import {EmailDelivery as Actual} from ${JSON.stringify(path)};
        export class EmailDelivery extends Actual {
          constructor(ctx, env) { Date.now=()=>Number(env.TEST_NOW); super(ctx,env); }
        }
        export default worker;`
      )
    }
    await esbuild.build({
      entryPoints: [entry],
      outfile: bundle,
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      external: ["cloudflare:*"],
    })
  }
  await compile(source)
  const config = runtimeConfig(bundle, label, coordinated)
  if (clock !== undefined) config.workers[0].bindings.TEST_NOW = String(clock)
  const start = () => new Miniflare(convertV4MiniflareOptions(config))
  let runtime = start()
  const send = async (to, code = "123456", type = "SignIn") => {
    const response = await runtime.dispatchFetch("https://mail.test/send", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ to, type, payload: { code } }),
    })
    await response.text()
    return {
      status: response.status,
      result: response.headers.get("x-cognia-mail-status"),
      retryAfter: response.headers.get("retry-after"),
    }
  }
  return {
    label,
    coordinated,
    send,
    restart: async (now = clock) => {
      await runtime.dispose()
      if (now !== undefined) config.workers[0].bindings.TEST_NOW = String(now)
      runtime = start()
    },
    upgradeTo: async (path) => {
      await runtime.dispose()
      await compile(path)
      runtime = start()
    },
    dispose: () => runtime.dispose(),
  }
}

async function compatibilityGuard(baseline) {
  const current = resolve(root, "services/logto-email/index.ts")
  const h = await createHarness("compatibility", baseline, true)
  const before = submissions
  try {
    assert.equal((await h.send("legacy@example.com")).status, 200)
    await h.upgradeTo(current)
    assert.equal((await h.send("legacy@example.com")).result, "duplicate")
    assert.equal((await h.send("legacy@example.com", "654321", "Register")).status, 429)
    const competing = await Promise.all(
      Array.from({ length: 32 }, (_, index) =>
        h.send(
          "competing-new@example.com",
          String(200000 + index),
          index % 2 ? "Register" : "SignIn"
        )
      )
    )
    assert.equal(competing.filter((response) => response.status === 200).length, 1)
    assert.equal(competing.filter((response) => response.status === 429).length, 31)
    assert.equal((await h.send("native@example.com")).status, 200)
    assert.equal((await h.send("failure-unknown@example.com")).status, 502)
    await h.upgradeTo(baseline)
    assert.equal((await h.send("native@example.com")).result, "duplicate")
    assert.equal((await h.send("failure-unknown@example.com")).status, 503)
    assert.equal((await h.send("native@example.com", "654321")).status, 429)
    assert.equal(submissions - before, 4)
  } finally {
    await h.dispose()
  }
  const first = Date.now() + 86_400_000
  const quota = await createHarness("hourly", current, true, first)
  const initial = submissions
  try {
    for (let i = 0; i < 10; i++) {
      await quota.restart(first + i * 70_000)
      assert.equal(
        (await quota.send("quota@example.com", String(100000 + i), i % 2 ? "Register" : "SignIn"))
          .status,
        200
      )
    }
    await quota.restart(first + 700_000)
    const denied = await quota.send("quota@example.com", "999990")
    assert.equal(denied.status, 429)
    assert.equal(denied.retryAfter, "2900")
    await quota.restart(first + 3_600_000)
    assert.equal((await quota.send("quota@example.com", "999991")).status, 200)
    await quota.restart(first + 3_660_000)
    const sliding = await quota.send("quota@example.com", "999992")
    assert.equal(sliding.status, 429)
    assert.equal(sliding.retryAfter, "10")
    assert.equal(submissions - initial, 11)
  } finally {
    await quota.dispose()
  }
  return {
    concurrentCodesRespectCooldown: true,
    upgradeRollbackDedupe: true,
    unknownOutcomeNoResend: true,
    hourlyQuotaAcrossProcessRestarts: true,
    slidingWindowBoundary: true,
  }
}

function newReport(h) {
  return {
    label: h.label,
    environment: "local workerd + SQLite + local mail receiver (20ms)",
    burstSize: 32,
    duplicateSubmissions: [],
    duplicateTimes: [],
    independentTimes: [],
  }
}
async function burst(h, report, round) {
  let start = performance.now(),
    before = submissions
  const duplicate = await Promise.all(
    Array.from({ length: 32 }, () => h.send(`duplicate-${round}@example.com`))
  )
  const elapsed = performance.now() - start
  assert(duplicate.every((r) => r.status === 200))
  assert.equal(submissions - before, h.coordinated ? 1 : 32)
  if (round > 0) {
    report.duplicateTimes.push(elapsed)
    report.duplicateSubmissions.push(submissions - before)
  }
  start = performance.now()
  before = submissions
  const distinct = await Promise.all(
    Array.from({ length: 32 }, (_, i) => h.send(`distinct-${round}-${i}@example.com`))
  )
  assert(distinct.every((r) => r.status === 200))
  assert.equal(submissions - before, 32)
  if (round > 0) report.independentTimes.push(performance.now() - start)
}
async function guardrails(h, samples) {
  if (!h.coordinated) return
  const before = submissions
  await h.restart()
  assert.equal((await h.send(`duplicate-${samples}@example.com`)).result, "duplicate")
  const cooldown = await Promise.all(
    Array.from({ length: 32 }, (_, i) =>
      h.send(`duplicate-${samples}@example.com`, String(100000 + i))
    )
  )
  assert(cooldown.every((r) => r.status === 429))
  assert.equal(submissions, before)
  const order = []
  await Promise.all([
    h.send("slow-independent@example.com").then(() => order.push("slow")),
    h.send("fast-independent@example.com").then(() => order.push("fast")),
  ])
  assert.deepEqual(order, ["fast", "slow"])
}
function finishReport(h, report) {
  return {
    ...report,
    samples: report.independentTimes.length,
    duplicateLatency: summary(report.duplicateTimes),
    independentLatency: summary(report.independentTimes),
    persistentDedupe: h.coordinated,
    independentRecipientsProgress: true,
  }
}
async function run(label, source, coordinated) {
  const h = await createHarness(label, source, coordinated),
    report = newReport(h)
  try {
    for (let round = 0; round <= samples; round++) await burst(h, report, round)
    await guardrails(h, samples)
    return finishReport(h, report)
  } finally {
    await h.dispose()
  }
}
async function paired(comparisons) {
  const harnesses = [],
    reports = []
  try {
    for (const comparison of comparisons) {
      const h = await createHarness(...comparison)
      harnesses.push(h)
      reports.push(newReport(h))
    }
    for (let round = 0; round <= samples; round++) {
      const order = round % 2 ? [0, 1] : [1, 0]
      for (const i of order) await burst(harnesses[i], reports[i], round)
    }
    for (const h of harnesses) await guardrails(h, samples)
    return harnesses.map((h, i) => finishReport(h, reports[i]))
  } finally {
    await Promise.all(harnesses.map((h) => h.dispose()))
  }
}

try {
  const reports = []
  const comparisons = []
  const baselineFlag = process.argv.indexOf("--baseline")
  if (baselineFlag !== -1) {
    const path = process.argv[baselineFlag + 1]
    assert(path, "--baseline needs a source path")
    await readFile(path)
    comparisons.push(["baseline", resolve(path), process.argv.includes("--baseline-durable")])
  }
  comparisons.push(["current", resolve(root, "services/logto-email/index.ts"), true])
  if (process.argv.includes("--reverse")) comparisons.reverse()
  if (process.argv.includes("--guards-only")) {
    assert(baselineFlag !== -1, "--guards-only requires --baseline")
  } else if (process.argv.includes("--paired")) {
    assert.equal(comparisons.length, 2, "--paired requires --baseline")
    reports.push(...(await paired(comparisons)))
  } else for (const comparison of comparisons) reports.push(await run(...comparison))
  if (process.argv.includes("--check-compatibility") || process.argv.includes("--guards-only")) {
    assert(
      baselineFlag !== -1 && process.argv.includes("--baseline-durable"),
      "compatibility check requires --baseline-durable and --baseline"
    )
    const guards = await compatibilityGuard(resolve(process.argv[baselineFlag + 1]))
    await writeFile(resolve(cache, "guard-results.json"), JSON.stringify(guards, null, 2))
    console.log(JSON.stringify(guards))
  }
  await writeFile(resolve(cache, "runtime-results.json"), JSON.stringify(reports, null, 2))
  console.log(
    JSON.stringify(
      reports.map(
        ({ duplicateTimes: _duplicateTimes, independentTimes: _independentTimes, ...report }) =>
          report
      ),
      null,
      2
    )
  )
} finally {
  receiver.closeAllConnections()
  receiver.close()
}
