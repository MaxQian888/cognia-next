import { build } from "esbuild"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { access, mkdir, mkdtemp, readFile, readdir, stat, writeFile, rm } from "node:fs/promises"
import { tmpdir, cpus } from "node:os"
import { dirname, join, resolve } from "node:path"
import { createRequire } from "node:module"
import { performance } from "node:perf_hooks"

const source = "lib/session-import/adapters/portable-agent-source.ts"
const revision = "5d48f846142312c8d344083b5240d32400b36946"
const dir = await mkdtemp(join(tmpdir(), "cognia-portable-perf-"))
const sha = (text) => createHash("sha256").update(text).digest("hex")
const median = (xs) => {
  const values = [...xs].sort((a, b) => a - b)
  return (values[Math.floor((values.length - 1) / 2)] + values[Math.floor(values.length / 2)]) / 2
}
const statistics = (xs) => {
  const mid = median(xs)
  return { median: mid, mad: median(xs.map((x) => Math.abs(x - mid))) }
}
const fileSystem = {
  async exists(path) {
    try {
      await access(path)
      return true
    } catch {
      return false
    }
  },
  async readDir(path) {
    return (await readdir(path)).sort()
  },
  async readDirEntries(path) {
    return (await readdir(path, { withFileTypes: true }))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => ({ name: entry.name, isFile: entry.isFile() }))
  },
  async stat(path) {
    const value = await stat(path)
    return { size: value.size, isFile: value.isFile() }
  },
  async readTextFile(path) {
    return readFile(path, "utf8")
  },
}
const timestamp = (i) => new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString()
function document(id, count, parent, toolBytes = 0) {
  const messages = []
  for (let i = 0; i < count; i++) {
    const common = { id: `m${i}`, timestamp: timestamp(i) }
    if (toolBytes && i % 3 === 2)
      messages.push({
        ...common,
        type: "tool_result",
        callId: `call${i - 1}`,
        output: "x".repeat(toolBytes),
      })
    else if (i % 3 === 1)
      messages.push({
        ...common,
        role: "assistant",
        content: [
          { type: "reasoning", text: "Inspect state" },
          { type: "text", text: "Working" },
        ],
        toolCalls: [{ id: `call${i}`, name: "read", input: { path: "fixture.ts" } }],
      })
    else messages.push({ ...common, role: "user", content: "Review this implementation." })
  }
  messages.push(
    { type: "checkpoint", id: "cp", timestamp: timestamp(count), turnId: "m0" },
    { type: "branch", id: "branch", timestamp: timestamp(count + 1), summary: "branch preserved" },
    {
      type: "background_job",
      id: "job",
      timestamp: timestamp(count + 2),
      status: "running",
      dependencies: ["previous"],
    },
    {
      type: "future_event",
      timestamp: timestamp(count + 3),
      apiKey: "secret",
      detail: "diagnostic retained",
    }
  )
  return {
    sessionId: id,
    parentSessionId: parent,
    kind: parent ? "subagent" : undefined,
    status: "interrupted",
    cwd: "/fixture",
    createdAt: timestamp(0),
    messages,
  }
}
async function put(path, text) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}
try {
  const baseline = execFileSync("git", ["show", `${revision}:${source}`], { encoding: "utf8" })
  const require = createRequire(import.meta.url)
  const modules = {}
  for (const variant of ["baseline", "candidate"]) {
    const outfile = join(dir, `${variant}.cjs`)
    await build({
      entryPoints: [source],
      outfile,
      bundle: true,
      platform: "node",
      format: "cjs",
      external: [
        "@/lib/file/file-operations",
        "@/lib/chat/media/normalize-message-media",
        "@/lib/claude/ipc",
        "@/lib/ai/generation/summarize-material",
        "@/lib/tauri",
      ],
      plugins: [
        {
          name: "unused-host-boundary",
          setup(builder) {
            builder.onResolve({ filter: /^@\/lib\/cli-bridge\/home$/ }, (args) => ({
              path: args.path,
              external: true,
              sideEffects: false,
            }))
          },
        },
        ...(variant === "baseline"
          ? [
              {
                name: "baseline",
                setup(builder) {
                  builder.onLoad({ filter: /\/adapters\/portable-agent-source\.ts$/ }, () => ({
                    contents: baseline,
                    loader: "ts",
                  }))
                },
              },
            ]
          : []),
      ],
    })
    modules[variant] = require(outfile).createPortableAgentSessionSource({
      id: "portable-perf",
      displayName: "Fixture",
      verifiedVersion: "fixture-1",
      acceptedExtensions: [".json", ".jsonl"],
      roots: (home) => [join(home, "artifacts")],
      pathHints: [],
      defaultTitle: "Fixture session",
    })
  }
  const result = {
    revision,
    node: process.version,
    cpu: cpus()[0].model,
    hashes: { baseline: sha(baseline), candidate: sha(await readFile(source)) },
    workloads: {},
  }
  for (const name of ["many", "long", "large-tools", "small"].filter(
    (name) => !process.env.PORTABLE_WORKLOAD || name === process.env.PORTABLE_WORKLOAD
  )) {
    const home = join(dir, name),
      count = name === "many" ? 2500 : 1
    let bytes = 0,
      files = 0
    for (let i = 0; i < count; i++) {
      const content = JSON.stringify(
        document(
          `root-${i}`,
          name === "long" ? 20000 : name === "large-tools" ? 900 : 4,
          undefined,
          name === "large-tools" ? 16384 : 0
        )
      )
      await put(join(home, "artifacts", `root-${String(i).padStart(4, "0")}.json`), content)
      bytes += Buffer.byteLength(content)
      files++
      if (name === "many" && i < 500) {
        const child = JSON.stringify(document(`child-${i}`, 3, `root-${i}`))
        await put(join(home, "artifacts", `child-${String(i).padStart(4, "0")}.json`), child)
        bytes += Buffer.byteLength(child)
        files++
      }
    }
    const samples = { baseline: [], candidate: [] }
    let expectedHash
    for (let iteration = -2; iteration < 12; iteration++) {
      for (const variant of iteration % 2 === 0
        ? ["baseline", "candidate"]
        : ["candidate", "baseline"]) {
        await new Promise(setImmediate)
        global.gc?.()
        const before = process.memoryUsage()
        const started = performance.now()
        const input = { fs: fileSystem, home },
          graphs = []
        const listed = await modules[variant].listSessions(input)
        for (const summary of listed)
          graphs.push(await modules[variant].parseGraph(summary.ref, input))
        const ms = performance.now() - started
        const transient = process.memoryUsage()
        global.gc?.()
        const retained = process.memoryUsage()
        const outputHash = sha(JSON.stringify({ listed, graphs }))
        expectedHash ??= outputHash
        if (outputHash !== expectedHash)
          throw new Error(`${name} ${variant} output mismatch ${outputHash} ${expectedHash}`)
        if (listed.length !== count) throw new Error(`Missing roots ${listed.length} != ${count}`)
        if (iteration >= 0)
          samples[variant].push({
            ms,
            heapDelta: transient.heapUsed - before.heapUsed,
            retainedHeapDelta: retained.heapUsed - before.heapUsed,
            rssDelta: transient.rss - before.rss,
            retainedHeapUsed: retained.heapUsed,
          })
        graphs.length = 0
      }
    }
    result.workloads[name] = {
      bytes,
      files,
      roots: count,
      outputHash: expectedHash,
      samples,
      summary: Object.fromEntries(
        Object.entries(samples).map(([variant, samples]) => [
          variant,
          {
            timeMs: statistics(samples.map((x) => x.ms)),
            retainedHeapBytes: statistics(samples.map((x) => x.retainedHeapDelta)),
            retainedProcessHeapBytes: statistics(samples.map((x) => x.retainedHeapUsed)),
          },
        ])
      ),
    }
    process.stderr.write(`${name} ${JSON.stringify(result.workloads[name].summary)}\n`)
  }
  console.log(JSON.stringify(result, null, 2))
} finally {
  await rm(dir, { recursive: true, force: true })
}
