/** Run actual scheduler sources in the real Tauri webview with a private fixture DB. */
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createHash, randomUUID } from "node:crypto"
import { build } from "esbuild"
import { connectTauriPage } from "../tauri/agent-debug-client.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const mode = process.env.SCHEDULER_SMOKE_MODE ?? "smoke"
if (!["smoke", "provider", "resume-arm", "resume-read", "resume-cleanup"].includes(mode))
  throw new Error("Unknown scheduler smoke mode")
const proxyFields = [
  "SCHEDULER_PROVIDER_BASE_URL",
  "SCHEDULER_PROVIDER_MODEL",
  "SCHEDULER_PROVIDER_API_KEY",
]
const hasProxy = mode === "provider" && proxyFields.some((key) => process.env[key])
if (hasProxy && !proxyFields.every((key) => process.env[key]?.trim()))
  throw new Error("All runtime proxy fields are required")
let providerConfig
if (hasProxy) {
  const base = new URL(process.env.SCHEDULER_PROVIDER_BASE_URL)
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new Error("Invalid runtime proxy URL")
  providerConfig = {
    provider: "openai",
    model: process.env.SCHEDULER_PROVIDER_MODEL,
    baseURL: base.href.replace(/\/$/, ""),
    apiKey: process.env.SCHEDULER_PROVIDER_API_KEY,
    apiFlavor: "chat",
  }
}
const runId = process.env.SCHEDULER_SMOKE_ID ?? randomUUID()
if (!/^[0-9a-f-]{36}$/.test(runId)) throw new Error("Invalid fixture run id")
const retained = ["resume-arm", "resume-read"].includes(mode)
const reuse = ["resume-read", "resume-cleanup"].includes(mode)
const artifactDir = path.join(root, ".cache/scheduler-fixes/native", runId)
const publicName = `.scheduler-smoke-${runId}`
const publicDir = path.join(root, "public", publicName)
const sourcePaths = [
  "lib/scheduler/task-scheduler.ts",
  "lib/scheduler/scheduler-db.ts",
  "lib/scheduler/daemon-bridge.ts",
  "lib/scheduler/errors.ts",
  "lib/scheduler/timing/rust-daemon-driver.ts",
  "scripts/smoke/fixtures/scheduler-tauri.ts",
  "lib/scheduler/occurrence.ts",
  "lib/scheduler/promoted-wake.ts",
  "lib/network/platform-streaming-fetch.ts",
  ...(mode === "provider" ? ["lib/twin/distill/llm.ts", "packages/redact/src/index.ts"] : []),
]
async function sourceHashes() {
  return Object.fromEntries(
    await Promise.all(
      sourcePaths.map(async (file) => [
        file,
        createHash("sha256")
          .update(await fs.readFile(path.join(root, file)))
          .digest("hex"),
      ])
    )
  )
}
await fs.mkdir(artifactDir, { recursive: true })
await fs.mkdir(publicDir, { recursive: true })
const schema = path.join(root, "lib/db/schema.ts")
const overrides = new Map([
  [
    "lib/scheduler/write-authority",
    "export const loadSchedulerPolicy = async () => ({ maxConcurrentExecutions: 5 })",
  ],
  ["lib/scheduler/notification-integration", "export const notifyTaskEvent = async () => {}"],
  ["lib/scheduler/event-integration", "export const emitSchedulerEvent = async () => {}"],
  [
    "lib/scheduler/task-completion-linkage",
    "export const dispatchScheduledTaskSettled = async () => {}",
  ],
  [
    "lib/scheduler/task-workspace-binding",
    "export const resolveTaskWorkspace = async () => undefined; export const backfillSessionWorkspace = async () => null",
  ],
  [
    "lib/scheduler/connection-task-orphans",
    "export const reapOrphanedConnectionTasks = async () => []",
  ],
  [
    "lib/scheduler/executor-owners",
    "export const hasTaskExecutorOwner = () => false; export const loadTaskExecutorOwner = async () => false",
  ],
  [
    "lib/plugin/messaging/hooks-system",
    "export const getPluginLifecycleHooks = () => ({ dispatchOnScheduledTaskStart() {}, dispatchOnScheduledTaskComplete() {}, dispatchOnScheduledTaskError() {} })",
  ],
])
let page
async function captureDiagnostics() {
  if (mode === "provider" || process.env.SCHEDULER_SMOKE_SHARED === "1") return
  const captures = [
    ["console.json", () => page.consoleMessages()],
    ["network.json", () => page.networkEvents()],
    ["native.log", () => page.nativeLogs({ lines: 200 })],
    ["tauri.png", () => page.screenshot({ path: path.join(artifactDir, "tauri.png") })],
  ]
  const outcomes = await Promise.allSettled(
    captures.map(async ([name, read]) => {
      const value = await read()
      if (name !== "tauri.png")
        await fs.writeFile(path.join(artifactDir, name), JSON.stringify(value, null, 2))
    })
  )
  await fs.writeFile(
    path.join(artifactDir, "diagnostics.json"),
    JSON.stringify(
      outcomes.map((outcome, index) => ({
        artifact: captures[index][0],
        status: outcome.status,
        ...(outcome.status === "rejected" ? { error: String(outcome.reason) } : {}),
      })),
      null,
      2
    )
  )
}
try {
  const sources = await sourceHashes()
  if (
    reuse &&
    JSON.stringify(sources) !==
      JSON.stringify(JSON.parse(await fs.readFile(path.join(artifactDir, "sources.json"), "utf8")))
  )
    throw new Error("Armed fixture sources changed")
  if (!reuse)
    await build({
      entryPoints: [path.join(root, "scripts/smoke/fixtures/scheduler-tauri.ts")],
      outfile: path.join(publicDir, "fixture.js"),
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "safari17",
      tsconfig: path.join(root, "tsconfig.json"),
      logLevel: "warning",
      define: {
        __SCHEDULER_SMOKE_ID__: JSON.stringify(runId),
        "process.env.NODE_ENV": JSON.stringify("test"),
        "process.env": "{}",
      },
      plugins: [
        {
          name: "isolated-scheduler-fixture",
          setup(builder) {
            builder.onResolve({ filter: /.*/ }, (args) => {
              const candidate = args.path.startsWith("@/")
                ? args.path.slice(2)
                : args.path.startsWith(".") && args.importer
                  ? path
                      .relative(root, path.resolve(path.dirname(args.importer), args.path))
                      .replaceAll(path.sep, "/")
                  : ""
              const key = candidate.replace(/\.tsx?$/, "")
              if (args.path === "@/lib/db/schema") return { path: "schema", namespace: "fixture" }
              if (overrides.has(key)) return { path: key, namespace: "fixture" }
              if (
                args.kind === "dynamic-import" &&
                !args.path.startsWith("@tauri-apps/") &&
                !args.path.startsWith("@ai-sdk/") &&
                !["@/lib/twin/distill/llm", "@cognia/redact"].includes(args.path)
              )
                return { path: args.path, external: true }
            })
            builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
              contents:
                args.path === "schema"
                  ? `export * from ${JSON.stringify(schema)}; import { CogniaDB } from ${JSON.stringify(schema)}; const db = new CogniaDB("scheduler-native-smoke-${runId}", "scheduler-native-smoke"); export const getDb = () => db;`
                  : overrides.get(args.path),
              loader: "ts",
              resolveDir: root,
            }))
          },
        },
      ],
    })
  if (JSON.stringify(sources) !== JSON.stringify(await sourceHashes()))
    throw new Error(
      "Scheduler sources changed during bundling; refusing mixed verification evidence"
    )
  await fs.writeFile(path.join(artifactDir, "sources.json"), JSON.stringify(sources, null, 2))
  await fs.copyFile(path.join(publicDir, "fixture.js"), path.join(artifactDir, "fixture.js"))
  page = connectTauriPage()
  page.setDefaultTimeout(mode === "provider" ? 120000 : 60000)
  const debugSession = page.endpoint.debugSession
  if (debugSession?.workspace !== root)
    throw new Error("Refusing a Tauri shell from another workspace or without managed identity")
  const capabilities = await page.capabilities()
  const identity = await page.evaluate(() => ({
    url: location.href,
    tauri: !!window.__TAURI_INTERNALS__,
    title: document.title,
  }))
  if (!identity.tauri || capabilities.apiVersion !== 3)
    throw new Error("Ready real Tauri agent-debug v3 is required")
  await fs.writeFile(
    path.join(artifactDir, "environment.json"),
    JSON.stringify({ runId, identity, capabilities, debugSession }, null, 2)
  )
  const serializedResult = await page.evaluate(
    async ({ url, mode, sharedShell, providerConfig }) => {
      let moduleResponse
      let phase = "module-fetch"
      try {
        const response = await fetch(url)
        phase = "module-body"
        const body = await response.text()
        moduleResponse = {
          status: response.status,
          type: response.headers.get("content-type"),
          bytes: body.length,
        }
        if (!response.ok) throw new Error(`Native fixture request failed (${response.status})`)
        phase = "module-import"
        const fixture = await import(url)
        const run = {
          smoke: () => fixture.runSchedulerNativeSmoke({ sharedShell }),
          provider: () => fixture.runSchedulerProviderSmoke(providerConfig),
          "resume-arm": fixture.armSchedulerResumeSmoke,
          "resume-read": fixture.readSchedulerResumeSmoke,
          "resume-cleanup": fixture.cleanupSchedulerResumeSmoke,
        }[mode]
        phase = "fixture-execution"
        return JSON.stringify(await run())
      } catch (error) {
        return JSON.stringify({
          passed: false,
          error: mode === "provider" ? "Provider fixture failed before completion" : String(error),
          ...(mode === "provider" ? {} : { stack: error?.stack }),
          moduleResponse,
          phase,
          errorType: error?.name,
        })
      }
    },
    {
      url: `/${publicName}/fixture.js`,
      mode,
      sharedShell: process.env.SCHEDULER_SMOKE_SHARED === "1",
      providerConfig,
    },
    { timeout: mode === "provider" ? 120000 : 60000 }
  )
  const result = JSON.parse(serializedResult)
  if (!retained && result.database === `scheduler-native-smoke-${runId}`) {
    const cleanup = await page.evaluate(
      async ({ database }) => ({
        fixtureDatabaseStillPresent: (await indexedDB.databases()).some(
          (entry) => entry.name === database
        ),
      }),
      { database: result.database }
    )
    await fs.writeFile(path.join(artifactDir, "cleanup.json"), JSON.stringify(cleanup, null, 2))
    if (cleanup.fixtureDatabaseStillPresent) {
      result.passed = false
      result.error = "Fixture database was not removed"
    }
  }
  await fs.writeFile(
    path.join(artifactDir, mode === "smoke" ? "results.json" : `${mode}-results.json`),
    JSON.stringify(result, null, 2)
  )
  if (mode !== "provider") await captureDiagnostics()
  process.stdout.write(JSON.stringify({ artifactDir, ...result }, null, 2) + "\n")
  if (!result.passed) process.exitCode = 1
} catch (error) {
  await fs.writeFile(
    path.join(artifactDir, "failure.txt"),
    mode === "provider"
      ? "Provider fixture infrastructure failed; reconcile persisted outcome before retrying"
      : error.stack || String(error)
  )
  if (page) await captureDiagnostics().catch(() => undefined)
  if (mode === "provider")
    throw new Error("Provider fixture infrastructure failed; see sanitized artifact status")
  throw error
} finally {
  if (!retained) await fs.rm(publicDir, { recursive: true, force: true })
}
