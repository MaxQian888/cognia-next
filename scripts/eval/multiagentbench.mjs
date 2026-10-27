import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { parseArgs } from "node:util"
import { fileURLToPath, pathToFileURL } from "node:url"
import { cliEsbuildOptions, loadEsbuild } from "../build/esbuild-shared.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
export const HELP = `Run Cognia on the pinned MultiAgentBench research split.

pnpm eval:multiagentbench [options]
  --dry-run                 Validate sources and save the plan; no model calls
  --cases N                 First N public tasks (default 3, max 100)
  --task-ids IDS            Explicit comma-separated public task IDs (overrides --cases)
  --repetitions N           Fixed repetitions (default 1, max 10)
  --seed N                  Balanced candidate-order seed (default 20261025)
  --model ID                Solver model (default ark-deepseek-v4.1-flash)
  --judge-model ID          Judge model (default same as solver)
  --reasoning-effort LEVEL  Compatible reasoning effort: low/medium/high (default low)
  --max-output-tokens N     Solver output budget per call (default 8192)
  --judge-max-output-tokens N  Judge output budget per call (default 8192)
  --base-url URL            Compatible endpoint (default http://127.0.0.1:8787/v1)
  --timeout-ms N            Solver deadline (default 180000)
  --judge-timeout-ms N      Independent deadline per judge call (default 60000)
  --token-budget N          Solver admission budget per trial (default 131072)
  --judge-token-budget N    Separate judge admission budget (default 131072)
  --source-dir PATH         Pinned source cache
  --offline                 Require all source files already cached
  --run-dir PATH            Fresh evidence directory (default .cache/multiagentbench/<timestamp>)
  --resume PATH             Resume a verified frozen v3 run without rebuilding
  --retry-interrupted       With --resume, explicitly authorize retrying unsettled cells
  --diagnostics POLICY      primary (default), all, or sampled
  --diagnostic-every N      Sample one in N tasks per roster-size stratum (default 10)
  --help                    Show help

Set COGNIA_TEAM_EVAL_API_KEY for the proxy credential. When absent, the local
aiden-llm-proxy key command is used if installed. Keys are never written to artifacts.
Profile: closed-book research-text; external literature tools are disabled.
Scores are a declared Cognia adaptation, not an official MARBLE leaderboard result.
`

function integer(value, label, fallback, min, max) {
  if (value === undefined) return fallback
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < min ||
    Number(value) > max
  )
    throw new Error(`${label} must be an integer from ${min} to ${max}`)
  return Number(value)
}
export function parseBenchmarkArgs(args) {
  const strings = [
    "cases",
    "task-ids",
    "repetitions",
    "seed",
    "model",
    "judge-model",
    "reasoning-effort",
    "max-output-tokens",
    "judge-max-output-tokens",
    "base-url",
    "timeout-ms",
    "judge-timeout-ms",
    "token-budget",
    "judge-token-budget",
    "source-dir",
    "run-dir",
    "resume",
    "diagnostics",
    "diagnostic-every",
  ]
  const options = Object.fromEntries(strings.map((name) => [name, { type: "string" }]))
  for (const name of ["dry-run", "offline", "help", "retry-interrupted"])
    options[name] = { type: "boolean" }
  const { values } = parseArgs({
    args: args[0] === "--" ? args.slice(1) : args,
    options,
    strict: true,
  })
  const model = values.model ?? "ark-deepseek-v4.1-flash"
  if (
    values.resume &&
    Object.keys(values).some((name) => !["resume", "retry-interrupted", "help"].includes(name))
  )
    throw new Error("Resume uses frozen options; protocol overrides are forbidden")
  if (values["retry-interrupted"] && !values.resume)
    throw new Error("--retry-interrupted requires --resume")
  const diagnostics = values.diagnostics ?? "primary"
  if (!["primary", "all", "sampled"].includes(diagnostics))
    throw new Error("Invalid diagnostic policy")
  const judgeModel = values["judge-model"] ?? model
  const taskIds = values["task-ids"]?.split(",")
  if (
    taskIds &&
    (taskIds.some((id) => !/^[a-zA-Z0-9._-]{1,80}$/.test(id)) ||
      new Set(taskIds).size !== taskIds.length)
  )
    throw new Error("Explicit task IDs must be valid, nonempty and unique")
  const reasoningEffort = values["reasoning-effort"] ?? "low"
  if (!["low", "medium", "high"].includes(reasoningEffort))
    throw new Error("Invalid reasoning effort")
  for (const id of [model, judgeModel])
    if (!/^[a-zA-Z0-9_./:-]{1,200}$/.test(id)) throw new Error("Invalid model ID")
  return {
    help: values.help ?? false,
    dryRun: values["dry-run"] ?? false,
    offline: values.offline ?? false,
    resumeDir: values.resume ? path.resolve(root, values.resume) : undefined,
    retryInterrupted: values["retry-interrupted"] ?? false,
    diagnostics,
    diagnosticEvery: integer(values["diagnostic-every"], "diagnostic-every", 10, 1, 100),
    cases: integer(values.cases, "cases", 3, 1, 100),
    taskIds,
    repetitions: integer(values.repetitions, "repetitions", 1, 1, 10),
    seed: integer(values.seed, "seed", 20261025, 0, 0xffff_ffff),
    timeoutMs: integer(values["timeout-ms"], "timeout-ms", 180000, 1000, 3_600_000),
    judgeTimeoutMs: integer(values["judge-timeout-ms"], "judge-timeout-ms", 60000, 1000, 3_600_000),
    tokenBudget: integer(values["token-budget"], "token-budget", 131072, 1, 2_000_000),
    judgeTokenBudget: integer(
      values["judge-token-budget"],
      "judge-token-budget",
      131072,
      1,
      2_000_000
    ),
    model,
    judgeModel,
    reasoningEffort,
    maxSolverOutputTokens: integer(
      values["max-output-tokens"],
      "max-output-tokens",
      8192,
      1,
      32768
    ),
    maxJudgeOutputTokens: integer(
      values["judge-max-output-tokens"],
      "judge-max-output-tokens",
      8192,
      1,
      16384
    ),
    baseURL: values["base-url"] ?? "http://127.0.0.1:8787/v1",
    sourceDir: values["source-dir"],
    runDir: path.resolve(
      root,
      values["run-dir"] ?? `.cache/multiagentbench/${new Date().toISOString().replaceAll(":", "-")}`
    ),
  }
}

export async function verifyFrozenRuntime(runDir) {
  const source = JSON.parse(await fs.readFile(path.join(runDir, "source-manifest.json"), "utf8"))
  const manifest = JSON.parse(await fs.readFile(path.join(runDir, "manifest.json"), "utf8"))
  if (
    manifest.schema !== "cognia.multiagentbench-research/v3" ||
    JSON.stringify(manifest.sourceManifest) !== JSON.stringify(source)
  )
    throw new Error("Frozen source manifest is missing or inconsistent")
  const entry = path.join(runDir, "runtime/multiagentbench.mjs")
  if (!Array.isArray(source.outputs) || !source.outputs.length)
    throw new Error("Frozen runtime has no output hashes")
  const files = new Set()
  for (const row of source.outputs) {
    const file = path.resolve(root, row.path)
    const relative = path.relative(path.join(runDir, "runtime"), file)
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || files.has(file))
      throw new Error("Frozen runtime output path is invalid")
    const stat = await fs.lstat(file)
    if (
      !stat.isFile() ||
      createHash("sha256")
        .update(await fs.readFile(file))
        .digest("hex") !== row.sha256
    )
      throw new Error("Frozen runtime checksum mismatch")
    files.add(file)
  }
  if (!files.has(entry)) throw new Error("Frozen runtime entry is not hash verified")
  return entry
}

/** Hash the exact bytes handed to esbuild, including virtual/plugin modules. */
export function captureBenchmarkBuild(options) {
  const inputs = new Map()
  const record = (args, result, contentKind) => {
    if (result?.contents === undefined) return
    const identity =
      args.namespace === "file"
        ? path.relative(root, args.path).replaceAll("\\", "/")
        : `${args.namespace}:${args.path}`
    inputs.set(identity, {
      path: identity,
      sha256: createHash("sha256").update(result.contents).digest("hex"),
      contentKind,
    })
  }
  const plugins = (options.plugins ?? []).map((plugin) => ({
    name: plugin.name,
    setup(build) {
      return plugin.setup({
        ...build,
        onLoad(filter, callback) {
          build.onLoad(filter, async (args) => {
            const result = await callback(args)
            record(args, result, "plugin-output")
            return result
          })
        },
      })
    },
  }))
  plugins.push({
    name: "capture-benchmark-inputs",
    setup(build) {
      build.onLoad({ filter: /.*/, namespace: "file" }, async (args) => {
        const extension = path.extname(args.path)
        const loader =
          options.loader?.[extension] ??
          {
            ".ts": "ts",
            ".tsx": "tsx",
            ".mts": "ts",
            ".cts": "ts",
            ".js": "js",
            ".jsx": "jsx",
            ".mjs": "js",
            ".cjs": "js",
            ".json": "json",
          }[extension]
        if (!loader) return
        const result = {
          contents: await fs.readFile(args.path),
          loader,
          resolveDir: path.dirname(args.path),
        }
        record(args, result, "source-bytes")
        return result
      })
    },
  })
  return { options: { ...options, absWorkingDir: root, plugins }, inputs }
}

export async function main(args = process.argv.slice(2), loadBuilder = loadEsbuild) {
  const options = parseBenchmarkArgs(args)
  if (options.help) {
    process.stdout.write(HELP)
    return
  }
  if (options.resumeDir) {
    const entry = await verifyFrozenRuntime(options.resumeDir)
    const { resumeBenchmark } = await import(pathToFileURL(entry).href)
    process.exitCode = await resumeBenchmark(options.resumeDir, options.retryInterrupted)
    return
  }
  await fs.mkdir(path.dirname(options.runDir), { recursive: true })
  // A new directory protects every prior runtime snapshot, including failed runs.
  await fs.mkdir(options.runDir)
  const esbuild = await loadBuilder()
  let result
  const captured = captureBenchmarkBuild(
    cliEsbuildOptions({
      root,
      entry: path.join(root, "scripts/eval/multiagentbench-runner.ts"),
      outdir: path.join(options.runDir, "runtime"),
      entryNames: "multiagentbench",
    })
  )
  try {
    result = await esbuild.build({
      ...captured.options,
      metafile: true,
    })
  } finally {
    // The frozen benchmark no longer needs the native build-service process.
    esbuild.stop()
  }
  async function hashes(entries) {
    const rows = []
    for (const file of Object.keys(entries)) {
      try {
        const bytes = await fs.readFile(path.resolve(root, file))
        rows.push({ path: file, sha256: createHash("sha256").update(bytes).digest("hex") })
      } catch (error) {
        if (!["ENOENT", "ENOTDIR", "EISDIR"].includes(error.code)) throw error
      }
    }
    return rows
  }
  const provenance = {
    builtAt: new Date().toISOString(),
    node: process.version,
    inputCapture: "exact-esbuild-loader-contents",
    inputs: Object.keys(result.metafile.inputs).map((file) => {
      const input = captured.inputs.get(file)
      if (!input) throw new Error(`Compiler input was not captured: ${file}`)
      return input
    }),
    outputs: await hashes(result.metafile.outputs),
  }
  await fs.writeFile(
    path.join(options.runDir, "source-manifest.json"),
    JSON.stringify(provenance, null, 2) + "\n",
    { flag: "wx" }
  )
  const { runBenchmark } = await import(
    pathToFileURL(path.join(options.runDir, "runtime/multiagentbench.mjs")).href
  )
  process.exitCode = await runBenchmark(options, provenance)
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
