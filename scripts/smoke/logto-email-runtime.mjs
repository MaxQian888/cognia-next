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
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ messageId: `local-${id}` }))
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

async function run(label, source, coordinated) {
  const bundle = resolve(cache, `${label}.mjs`)
  await esbuild.build({
    entryPoints: [source],
    outfile: bundle,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
  })
  const options = {
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
  const runtimeOptions = convertV4MiniflareOptions(options)
  let runtime = new Miniflare(runtimeOptions)
  const send = async (to, code = "123456") => {
    const response = await runtime.dispatchFetch("https://mail.test/send", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ to, type: "SignIn", payload: { code } }),
    })
    await response.text()
    return { status: response.status, result: response.headers.get("x-cognia-mail-status") }
  }
  try {
    const duplicateTimes = [],
      independentTimes = [],
      duplicateSubmissions = []
    for (let round = 0; round < 11; round++) {
      let start = performance.now(),
        before = submissions
      const duplicate = await Promise.all(
        Array.from({ length: 32 }, () => send(`duplicate-${round}@example.com`))
      )
      const elapsed = performance.now() - start
      assert(duplicate.every((result) => result.status === 200))
      assert.equal(submissions - before, coordinated ? 1 : 32)
      if (round > 0) {
        duplicateTimes.push(elapsed)
        duplicateSubmissions.push(submissions - before)
      }
      start = performance.now()
      before = submissions
      const distinct = await Promise.all(
        Array.from({ length: 32 }, (_, index) => send(`distinct-${round}-${index}@example.com`))
      )
      assert(distinct.every((result) => result.status === 200))
      assert.equal(submissions - before, 32)
      if (round > 0) independentTimes.push(performance.now() - start)
    }
    if (coordinated) {
      const before = submissions
      await runtime.dispose()
      runtime = new Miniflare(runtimeOptions)
      assert.equal((await send("duplicate-10@example.com")).result, "duplicate")
      assert.equal((await send("duplicate-10@example.com", "654321")).status, 429)
      assert.equal(submissions, before)
      const order = []
      await Promise.all([
        send("slow-independent@example.com").then(() => order.push("slow")),
        send("fast-independent@example.com").then(() => order.push("fast")),
      ])
      assert.deepEqual(order, ["fast", "slow"])
    }
    return {
      label,
      environment: "local workerd + SQLite + local mail receiver (20ms)",
      samples: 10,
      burstSize: 32,
      duplicateSubmissions,
      duplicateLatency: summary(duplicateTimes),
      independentLatency: summary(independentTimes),
      duplicateTimes,
      independentTimes,
      persistentDedupe: coordinated,
      independentRecipientsProgress: true,
    }
  } finally {
    await runtime.dispose()
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
  for (const comparison of comparisons) reports.push(await run(...comparison))
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
