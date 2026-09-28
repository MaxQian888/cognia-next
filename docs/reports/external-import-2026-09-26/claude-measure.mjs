import { build } from "esbuild"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { access, mkdir, mkdtemp, readFile, readdir, stat, writeFile, rm } from "node:fs/promises"
import { tmpdir, cpus } from "node:os"
import { dirname, join, resolve } from "node:path"
import { createRequire } from "node:module"
import { performance } from "node:perf_hooks"

const source = "lib/session-import/adapters/claude-code.ts"
const revision = "5d48f846142312c8d344083b5240d32400b36946"
const dir = await mkdtemp(join(tmpdir(), "cognia-claude-perf-"))
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
function transcript(count, id, toolBytes = 0) {
  const records = []
  for (let i = 0; i < count; i++) {
    const common = {
      uuid: `r${i}`,
      parentUuid: i ? `r${i - 1}` : null,
      sessionId: id,
      cwd: "/fixture",
      timestamp: timestamp(i),
    }
    if (toolBytes && i % 3 === 2)
      records.push({
        ...common,
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: `call${i - 1}`, content: "x".repeat(toolBytes) },
          ],
        },
      })
    else if (i % 3 === 1)
      records.push({
        ...common,
        type: "assistant",
        message: {
          model: "claude-fixture",
          usage: { input_tokens: 100, output_tokens: 50 },
          content: [
            { type: "thinking", thinking: "Inspect state" },
            { type: "text", text: "Reading source" },
            {
              type: "tool_use",
              id: `call${i}`,
              name: "Read",
              input: { path: "/fixture/source.ts" },
            },
          ],
        },
      })
    else
      records.push({
        ...common,
        type: "user",
        message: { content: "Follow up on the current implementation." },
      })
  }
  return records
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
                  builder.onLoad({ filter: /\/adapters\/claude-code\.ts$/ }, () => ({
                    contents: baseline,
                    loader: "ts",
                  }))
                },
              },
            ]
          : []),
      ],
    })
    modules[variant] = require(outfile).claudeCodeSessionSource
  }
  const result = {
    revision,
    node: process.version,
    cpu: cpus()[0].model,
    hashes: { baseline: sha(baseline), candidate: sha(await readFile(source)) },
    workloads: {},
  }
  for (const name of ["long", "large-tools", "teams", "single-owner", "small"].filter(
    (name) => !process.env.CLAUDE_WORKLOAD || name === process.env.CLAUDE_WORKLOAD
  )) {
    const home = join(dir, name),
      roots = [],
      batch = name === "teams" ? 16 : 1
    let bytes = 0,
      files = 0
    for (let j = 0; j < batch; j++) {
      const id = `session-${j}`,
        path = join(home, ".claude/projects/project", `${id}.jsonl`)
      const records = transcript(
        name === "long"
          ? 12000
          : name === "large-tools"
            ? 1800
            : name === "teams" || name === "single-owner"
              ? 100
              : 20,
        id,
        name === "large-tools" ? 16384 : 0
      )
      if (name === "large-tools") {
        records.push({
          type: "assistant",
          uuid: "abandoned",
          parentUuid: "r0",
          sessionId: id,
          timestamp: timestamp(1),
          message: { content: "abandoned" },
        })
        records.push({
          type: "user",
          uuid: "side-root",
          parentUuid: "r1",
          sessionId: id,
          isSidechain: true,
          timestamp: timestamp(2),
          message: { content: "Research a detail" },
        })
        records.push({
          type: "assistant",
          uuid: "side-leaf",
          parentUuid: "side-root",
          sessionId: id,
          isSidechain: true,
          timestamp: timestamp(3),
          message: { content: "Research complete" },
        })
        for (let segment = 0; segment < 2; segment++) {
          const child = transcript(8, id).map((rec, i) => ({
            ...rec,
            agentId: "independent-worker",
            timestamp: timestamp(10 + segment * 10 + i),
          }))
          const text = child.map(JSON.stringify).join("\n")
          await put(join(path.replace(/\.jsonl$/, ""), "subagents", `agent-${segment}.jsonl`), text)
          bytes += Buffer.byteLength(text)
          files++
        }
      }
      const content =
        records.map(JSON.stringify).join("\n") +
        (name === "large-tools" ? '\n{"type":"user","unfinished"' : "")
      await put(path, content)
      bytes += Buffer.byteLength(content)
      files++
      roots.push({ sourceId: "claude-code", originalSessionId: id, locator: path })
    }
    if (name === "teams" || name === "single-owner") {
      const text = JSON.stringify({
        name: "perf-team",
        cwd: "/fixture",
        leadSessionId: "session-0",
        members: Array.from({ length: name === "single-owner" ? 1 : 160 }, (_, i) => ({
          sessionId: `worker-session-${i}`,
          agentId: `worker-${i}@team`,
          name: `worker-${i}`,
          status: "running",
        })),
      })
      await put(join(home, ".claude/teams/perf-team/config.json"), text)
      bytes += Buffer.byteLength(text)
      files++
      for (let i = 0; i < 4000; i++) {
        const text = JSON.stringify({
          id: `task-${i}`,
          subject: `Task ${i}`,
          status: i % 2 ? "completed" : "pending",
          owner:
            name === "single-owner"
              ? i === 0
                ? "worker-0"
                : `former-${i}`
              : i < 3840
                ? `former-${i}`
                : `worker-${i - 3840}`,
          blockedBy: i ? [`task-${i - 1}`] : [],
          background: true,
        })
        await put(join(home, ".claude/tasks/perf-team", `${String(i).padStart(5, "0")}.json`), text)
        bytes += Buffer.byteLength(text)
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
        for (const ref of roots) graphs.push(await modules[variant].parseGraph(ref, input))
        const ms = performance.now() - started
        const transient = process.memoryUsage()
        global.gc?.()
        const retained = process.memoryUsage()
        const outputHash = sha(JSON.stringify(graphs))
        expectedHash ??= outputHash
        if (outputHash !== expectedHash)
          throw new Error(`${name} ${variant} output mismatch ${outputHash} ${expectedHash}`)
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
      batch,
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
